import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const generateQr = vi.hoisted(() => vi.fn())
vi.mock('qrcode-terminal', () => ({ default: { generate: generateQr } }))
const standaloneLogin = vi.hoisted(() => vi.fn())
vi.mock('../src/standalone-login.js', () => ({ loginStandalone: standaloneLogin }))

import { run } from '../src/cli.js'
import { WeixinControlServer } from '../src/control.js'
import type { WeixinCredential } from '../src/types.js'

const temporaryDirectories: string[] = []
const CREDENTIAL: WeixinCredential = {
  token: 'test-token',
  accountId: 'account@im.bot',
  userId: 'user@im.wechat',
  baseUrl: 'https://ilink.example',
}

afterEach(async () => {
  vi.restoreAllMocks()
  generateQr.mockReset()
  standaloneLogin.mockReset()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('dsh-weixin CLI', () => {
  it('requests login from the running plugin and renders the QR in this terminal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-cli-'))
    temporaryDirectories.push(directory)
    const socketPath = join(directory, 'control.sock')
    const server = new WeixinControlServer(
      socketPath,
      vi.fn(async () => ({
        kind: 'qr-shown' as const,
        reused: false,
        url: 'https://qr.example/in-cli',
        completion: Promise.resolve(CREDENTIAL),
      })),
      { info: vi.fn(), warn: vi.fn() },
    )
    server.startInBackground()
    await vi.waitFor(async () => expect((await lstat(socketPath)).isSocket()).toBe(true))
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await expect(run(['login', '--socket', socketPath])).resolves.toBe(0)
    expect(generateQr).toHaveBeenCalledWith('https://qr.example/in-cli', { small: true })
    expect(output.mock.calls.flat().join('')).toContain('https://qr.example/in-cli')

    await server.stop()
  })

  it('prints exactly the URL and does not render a QR with --url', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-cli-url-'))
    temporaryDirectories.push(directory)
    const socketPath = join(directory, 'control.sock')
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
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await expect(run(['login', '--url', '--socket', socketPath])).resolves.toBe(0)
    expect(output.mock.calls.flat().join('')).toBe('https://qr.example/url-only')
    expect(generateQr).not.toHaveBeenCalled()
    expect(requestLogin.mock.calls[0]?.[1]).toBe(false)

    await server.stop()
  })

  it('prints the live QR URL before waiting for authorization and hot-switch completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-cli-wait-'))
    temporaryDirectories.push(directory)
    const socketPath = join(directory, 'control.sock')
    let finishLogin!: (credential: WeixinCredential) => void
    const completion = new Promise<WeixinCredential>(resolve => { finishLogin = resolve })
    const server = new WeixinControlServer(
      socketPath,
      vi.fn(async () => ({
        kind: 'qr-shown' as const,
        reused: false,
        url: 'https://qr.example/wait-live',
        completion,
      })),
      { info: vi.fn(), warn: vi.fn() },
    )
    server.startInBackground()
    await vi.waitFor(async () => expect((await lstat(socketPath)).isSocket()).toBe(true))
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    let finished = false

    const runTask = run(['login', '--url', '--wait', '--socket', socketPath]).finally(() => { finished = true })
    await vi.waitFor(() => expect(output.mock.calls.flat().join('')).toBe('https://qr.example/wait-live'))
    expect(finished).toBe(false)

    finishLogin(CREDENTIAL)
    await expect(runTask).resolves.toBe(0)
    expect(output.mock.calls.flat().join('')).toBe('https://qr.example/wait-live')
    expect(generateQr).not.toHaveBeenCalled()

    await server.stop()
  })

  it('keeps URL-only stdout clean when live authorization fails after showing the URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-cli-wait-fail-'))
    temporaryDirectories.push(directory)
    const socketPath = join(directory, 'control.sock')
    let failLogin!: (error: Error) => void
    const completion = new Promise<WeixinCredential>((_resolve, reject) => { failLogin = reject })
    const server = new WeixinControlServer(
      socketPath,
      vi.fn(async () => ({
        kind: 'qr-shown' as const,
        reused: false,
        url: 'https://qr.example/wait-failure',
        completion,
      })),
      { info: vi.fn(), warn: vi.fn() },
    )
    server.startInBackground()
    await vi.waitFor(async () => expect((await lstat(socketPath)).isSocket()).toBe(true))
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const runTask = run(['login', '--url', '--wait=true', '--socket', socketPath])
    await vi.waitFor(() => expect(output.mock.calls.flat().join('')).toBe('https://qr.example/wait-failure'))
    failLogin(new Error('scan expired'))

    await expect(runTask).resolves.toBe(1)
    expect(output.mock.calls.flat().join('')).toBe('https://qr.example/wait-failure')
    expect(errors.mock.calls.flat().join('')).toContain('scan expired')

    await server.stop()
  })

  it('logs in independently when Web and its control socket are not running', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-cli-offline-'))
    temporaryDirectories.push(directory)
    const socketPath = join(directory, 'missing.sock')
    let finishLogin!: (credential: WeixinCredential) => void
    standaloneLogin.mockImplementation(async (options: {
      showQr(url: string): Promise<void>
    }) => {
      await options.showQr('https://qr.example/standalone')
      return new Promise<WeixinCredential>(resolve => { finishLogin = resolve })
    })
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    let finished = false

    const runTask = run(['login', '--url', '--wait', '--socket', socketPath]).finally(() => { finished = true })
    await vi.waitFor(() => expect(output.mock.calls.flat().join('')).toBe('https://qr.example/standalone'))
    expect(finished).toBe(false)
    expect(standaloneLogin).toHaveBeenCalledOnce()

    finishLogin(CREDENTIAL)
    await expect(runTask).resolves.toBe(0)
    expect(output.mock.calls.flat().join('')).toBe('https://qr.example/standalone')
  })

  it('returns nonzero when independent authorization fails after emitting the URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-cli-offline-fail-'))
    temporaryDirectories.push(directory)
    const socketPath = join(directory, 'missing.sock')
    standaloneLogin.mockImplementation(async (options: {
      showQr(url: string): Promise<void>
    }) => {
      await options.showQr('https://qr.example/standalone-failure')
      throw new Error('standalone timeout')
    })
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await expect(run(['login', '--url', '--wait', '--socket', socketPath])).resolves.toBe(1)
    expect(output.mock.calls.flat().join('')).toBe('https://qr.example/standalone-failure')
    expect(errors.mock.calls.flat().join('')).toContain('standalone timeout')
  })
})
