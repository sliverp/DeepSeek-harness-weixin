import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import type { WeixinLoginRequest } from './bridge.js'

const MAX_CONTROL_MESSAGE_BYTES = 4_096
const DEFAULT_CLIENT_TIMEOUT_MS = 30_000

export type WeixinControlResponse =
  | { ok: true; kind: 'qr'; reused: boolean; url: string }
  | { ok: false; error: string }

export interface WeixinControlRequestOptions {
  timeoutMs?: number
  urlOnly?: boolean
}

export interface WeixinControlLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

/** Default owner-only control socket shared by the plugin runtime and its CLI. */
export function defaultControlSocketPath(): string {
  return join(homedir(), '.dsh', 'weixin', 'control.sock')
}

/** Resolve a configured CLI/server socket path without accepting relative ambiguity. */
export function resolveControlSocketPath(configured?: string): string {
  const value = configured?.trim() || process.env.DSH_WEIXIN_CONTROL_SOCKET?.trim()
  if (!value) return defaultControlSocketPath()
  return isAbsolute(value) ? value : resolve(value)
}

/** Owner-only Unix socket that lets a shell request QR login from the live plugin. */
export class WeixinControlServer {
  private server: Server | undefined
  private startTask: Promise<void> | undefined
  private readonly clients = new Set<Socket>()
  private ownsSocket = false
  private stopping = false

  constructor(
    readonly socketPath: string,
    private readonly requestLogin: (signal?: AbortSignal, displayQr?: boolean) => Promise<WeixinLoginRequest>,
    private readonly log: WeixinControlLogger,
  ) {
    if (!isAbsolute(socketPath)) throw new Error(`weixin control socket path must be absolute, got ${JSON.stringify(socketPath)}`)
  }

  /** Listen without making Harness Web await filesystem or socket setup. */
  startInBackground(): void {
    if (this.startTask !== undefined || this.stopping) return
    const task = this.start()
    this.startTask = task
    void task.catch(error => {
      if (!this.stopping) this.log.warn('Weixin CLI control socket is unavailable: %s', renderError(error))
    })
  }

  /** Close active clients and remove the socket during plugin teardown. */
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (this.startTask !== undefined) await Promise.allSettled([this.startTask])
    for (const client of this.clients) client.destroy()
    const server = this.server
    if (server !== undefined) {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()))
      this.server = undefined
    }
    if (this.ownsSocket) {
      await unlinkIfPresent(this.socketPath)
      this.ownsSocket = false
    }
  }

  private async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 })
    await removeStaleSocket(this.socketPath)
    if (this.stopping) return

    const server = createServer(socket => this.accept(socket))
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => rejectListen(error)
      server.once('error', onError)
      server.listen(this.socketPath, () => {
        server.off('error', onError)
        resolveListen()
      })
    })
    this.ownsSocket = true
    if (this.stopping) {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()))
      await unlinkIfPresent(this.socketPath)
      this.ownsSocket = false
      return
    }
    server.on('error', error => this.log.warn('Weixin CLI control socket failed: %s', renderError(error)))
    this.server = server
    await chmod(this.socketPath, 0o600)
    this.log.info('Weixin CLI control socket listening at %s', this.socketPath)
  }

  private accept(socket: Socket): void {
    this.clients.add(socket)
    socket.setEncoding('utf8')
    const controller = new AbortController()
    let input = ''
    let handled = false

    const finish = (): void => {
      this.clients.delete(socket)
      if (!controller.signal.aborted) controller.abort(new Error('Weixin CLI client disconnected'))
    }
    socket.once('close', finish)
    socket.on('data', chunk => {
      if (handled) return
      input += chunk
      if (Buffer.byteLength(input, 'utf8') > MAX_CONTROL_MESSAGE_BYTES) {
        handled = true
        this.respond(socket, { ok: false, error: 'control request is too large' })
        return
      }
      const newline = input.indexOf('\n')
      if (newline < 0) return
      handled = true
      const line = input.slice(0, newline)
      void this.handle(line, controller.signal).then(
        response => this.respond(socket, response),
        error => this.respond(socket, { ok: false, error: renderError(error) }),
      )
    })
  }

  private async handle(line: string, signal: AbortSignal): Promise<WeixinControlResponse> {
    let request: unknown
    try {
      request = JSON.parse(line)
    } catch {
      return { ok: false, error: 'invalid control request' }
    }
    if (!isLoginRequest(request)) return { ok: false, error: 'unknown control command' }
    // The control client owns presentation: the ordinary CLI renders the QR in
    // its terminal, while --url prints only the returned URL.
    const result = await this.requestLogin(signal, false)
    return { ok: true, kind: 'qr', reused: result.reused, url: result.url }
  }

  private respond(socket: Socket, response: WeixinControlResponse): void {
    if (socket.destroyed) return
    socket.end(`${JSON.stringify(response)}\n`)
  }
}

/** Ask the live plugin for a QR from a one-shot Linux CLI process. */
export function requestLoginFromControlSocket(
  socketPath: string,
  options: WeixinControlRequestOptions | number = {},
): Promise<WeixinControlResponse> {
  if (!isAbsolute(socketPath)) return Promise.reject(new Error('control socket path must be absolute'))
  const resolvedOptions = typeof options === 'number' ? { timeoutMs: options } : options
  return new Promise<WeixinControlResponse>((resolveResponse, rejectResponse) => {
    const socket = createConnection(socketPath)
    let input = ''
    let settled = false
    const timeoutMs = resolvedOptions.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS
    const timer = setTimeout(() => settleError(new Error(`control request timed out after ${timeoutMs}ms`)), timeoutMs)

    const cleanup = (): void => {
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
    }
    const settleError = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectResponse(error)
    }
    const settleValue = (value: WeixinControlResponse): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveResponse(value)
    }

    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(`${JSON.stringify({
      command: 'login',
      ...(resolvedOptions.urlOnly === true ? { urlOnly: true } : {}),
    })}\n`))
    socket.once('error', settleError)
    socket.on('data', chunk => {
      input += chunk
      if (Buffer.byteLength(input, 'utf8') > MAX_CONTROL_MESSAGE_BYTES) {
        settleError(new Error('control response is too large'))
        return
      }
      const newline = input.indexOf('\n')
      if (newline < 0) return
      try {
        settleValue(parseControlResponse(JSON.parse(input.slice(0, newline))))
      } catch (error) {
        settleError(error instanceof Error ? error : new Error(renderError(error)))
      }
    })
    socket.once('end', () => {
      if (!settled) settleError(new Error('control socket closed without a response'))
    })
  })
}

function isLoginRequest(value: unknown): value is { command: 'login'; urlOnly?: boolean } {
  return typeof value === 'object' && value !== null
    && (value as { command?: unknown }).command === 'login'
    && ((value as { urlOnly?: unknown }).urlOnly === undefined
      || typeof (value as { urlOnly?: unknown }).urlOnly === 'boolean')
}

function parseControlResponse(value: unknown): WeixinControlResponse {
  if (typeof value !== 'object' || value === null) throw new Error('invalid control response')
  const response = value as Record<string, unknown>
  if (response.ok === false && typeof response.error === 'string') {
    return { ok: false, error: response.error }
  }
  if (response.ok === true && response.kind === 'qr' && typeof response.url === 'string'
    && typeof response.reused === 'boolean') {
    return { ok: true, kind: 'qr', reused: response.reused, url: response.url }
  }
  throw new Error('invalid control response')
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  let stat
  try {
    stat = await lstat(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stat.isSocket()) throw new Error(`refusing to replace non-socket path ${socketPath}`)
  if (await socketAcceptsConnections(socketPath)) {
    throw new Error(`another Weixin plugin is already listening at ${socketPath}`)
  }
  await unlinkIfPresent(socketPath)
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolveProbe, rejectProbe) => {
    const socket = createConnection(socketPath)
    const timer = setTimeout(() => finish(new Error(`timed out probing ${socketPath}`)), 500)
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
    }
    const finish = (error?: Error, live?: boolean): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error !== undefined) rejectProbe(error)
      else resolveProbe(live ?? false)
    }
    socket.once('connect', () => finish(undefined, true))
    socket.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED' || code === 'ENOENT') finish(undefined, false)
      else finish(error)
    })
  })
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function renderError(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '<unrenderable error>'
  }
}
