import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const generateQr = vi.hoisted(() => vi.fn())
vi.mock('qrcode-terminal', () => ({ default: { generate: generateQr } }))

import { run } from '../src/cli.js'
import { WeixinControlServer } from '../src/control.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  generateQr.mockReset()
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
})
