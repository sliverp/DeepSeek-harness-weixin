import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  requestLoginFromControlSocket,
  waitForLoginFromControlSocket,
  WeixinControlServer,
} from '../src/control.js'
import type { WeixinCredential } from '../src/types.js'

const temporaryDirectories: string[] = []
const CREDENTIAL: WeixinCredential = {
  token: 'test-token',
  accountId: 'account@im.bot',
  userId: 'user@im.wechat',
  baseUrl: 'https://ilink.example',
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporarySocketPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-control-'))
  temporaryDirectories.push(directory)
  return join(directory, 'control.sock')
}

describe('WeixinControlServer', () => {
  it('returns a fresh QR URL over an owner-only Unix socket', async () => {
    const socketPath = await temporarySocketPath()
    const requestLogin = vi.fn(async (_signal?: AbortSignal, _displayQr?: boolean) => ({
      kind: 'qr-shown' as const,
      reused: false,
      url: 'https://qr.example/from-cli',
      completion: Promise.resolve(CREDENTIAL),
    }))
    const server = new WeixinControlServer(
      socketPath,
      requestLogin,
      { info: vi.fn(), warn: vi.fn() },
    )

    expect(server.startInBackground()).toBeUndefined()
    await vi.waitFor(async () => expect((await lstat(socketPath)).isSocket()).toBe(true))
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o600)

    await expect(requestLoginFromControlSocket(socketPath)).resolves.toMatchObject({
      ok: true,
      kind: 'qr',
      reused: false,
      url: 'https://qr.example/from-cli',
      loginId: expect.any(String),
    })
    expect(requestLogin).toHaveBeenCalledOnce()
    expect(requestLogin.mock.calls[0]?.[1]).toBe(false)

    await server.stop()
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('asks the bridge not to render when the client requests URL-only output', async () => {
    const socketPath = await temporarySocketPath()
    const requestLogin = vi.fn(async (_signal?: AbortSignal, _displayQr?: boolean) => ({
      kind: 'qr-shown' as const,
      reused: false,
      url: 'https://qr.example/url-only',
      completion: Promise.resolve(CREDENTIAL),
    }))
    const server = new WeixinControlServer(
      socketPath,
      requestLogin,
      { info: vi.fn(), warn: vi.fn() },
    )
    server.startInBackground()
    await vi.waitFor(async () => expect((await lstat(socketPath)).isSocket()).toBe(true))

    await expect(requestLoginFromControlSocket(socketPath, { urlOnly: true })).resolves.toMatchObject({
      ok: true,
      kind: 'qr',
      reused: false,
      url: 'https://qr.example/url-only',
      loginId: expect.any(String),
    })
    expect(requestLogin.mock.calls[0]?.[1]).toBe(false)

    await server.stop()
  })

  it('contains socket startup failure instead of throwing synchronously', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-control-file-'))
    temporaryDirectories.push(directory)
    const logger = { info: vi.fn(), warn: vi.fn() }
    const server = new WeixinControlServer(
      directory,
      vi.fn(async () => ({
        kind: 'qr-shown' as const,
        reused: false,
        url: 'https://qr.example/unreachable',
        completion: Promise.resolve(CREDENTIAL),
      })),
      logger,
    )

    expect(server.startInBackground()).toBeUndefined()
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled())
    await server.stop()
  })

  it('waits for the same login attempt to authorize and finish hot-switching', async () => {
    const socketPath = await temporarySocketPath()
    let finishLogin!: (credential: WeixinCredential) => void
    const completion = new Promise<WeixinCredential>(resolve => { finishLogin = resolve })
    const server = new WeixinControlServer(
      socketPath,
      vi.fn(async () => ({
        kind: 'qr-shown' as const,
        reused: false,
        url: 'https://qr.example/wait',
        completion,
      })),
      { info: vi.fn(), warn: vi.fn() },
    )
    server.startInBackground()
    await vi.waitFor(async () => expect((await lstat(socketPath)).isSocket()).toBe(true))

    const started = await requestLoginFromControlSocket(socketPath)
    expect(started).toMatchObject({ ok: true, kind: 'qr', loginId: expect.any(String) })
    if (!started.ok || started.kind !== 'qr' || started.loginId === undefined) {
      throw new Error('expected a tracked QR login')
    }
    let finished = false
    const waitTask = waitForLoginFromControlSocket(socketPath, started.loginId).finally(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)

    finishLogin(CREDENTIAL)
    await expect(waitTask).resolves.toEqual({
      ok: true,
      kind: 'connected',
      accountId: CREDENTIAL.accountId,
      userId: CREDENTIAL.userId,
      baseUrl: CREDENTIAL.baseUrl,
    })

    await server.stop()
  })

  it('reports a rejected login attempt to the waiting client', async () => {
    const socketPath = await temporarySocketPath()
    let failLogin!: (error: Error) => void
    const completion = new Promise<WeixinCredential>((_resolve, reject) => { failLogin = reject })
    const server = new WeixinControlServer(
      socketPath,
      vi.fn(async () => ({
        kind: 'qr-shown' as const,
        reused: false,
        url: 'https://qr.example/failure',
        completion,
      })),
      { info: vi.fn(), warn: vi.fn() },
    )
    server.startInBackground()
    await vi.waitFor(async () => expect((await lstat(socketPath)).isSocket()).toBe(true))

    const started = await requestLoginFromControlSocket(socketPath)
    if (!started.ok || started.kind !== 'qr' || started.loginId === undefined) {
      throw new Error('expected a tracked QR login')
    }
    const waitTask = waitForLoginFromControlSocket(socketPath, started.loginId)
    failLogin(new Error('authorization expired'))
    await expect(waitTask).resolves.toEqual({ ok: false, error: 'Error: authorization expired' })

    await server.stop()
  })
})
