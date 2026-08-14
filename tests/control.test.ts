import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestLoginFromControlSocket, WeixinControlServer } from '../src/control.js'

const temporaryDirectories: string[] = []

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
    const requestLogin = vi.fn(async () => ({
      kind: 'qr-shown' as const,
      reused: false,
      url: 'https://qr.example/from-cli',
    }))
    const server = new WeixinControlServer(
      socketPath,
      requestLogin,
      { info: vi.fn(), warn: vi.fn() },
    )

    expect(server.startInBackground()).toBeUndefined()
    await vi.waitFor(async () => expect((await lstat(socketPath)).isSocket()).toBe(true))
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o600)

    await expect(requestLoginFromControlSocket(socketPath)).resolves.toEqual({
      ok: true,
      kind: 'qr',
      reused: false,
      url: 'https://qr.example/from-cli',
    })
    expect(requestLogin).toHaveBeenCalledOnce()

    await server.stop()
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports an already connected channel without requesting another writer', async () => {
    const socketPath = await temporarySocketPath()
    const requestLogin = vi.fn(async () => ({ kind: 'connected' as const }))
    const server = new WeixinControlServer(
      socketPath,
      requestLogin,
      { info: vi.fn(), warn: vi.fn() },
    )
    server.startInBackground()
    await vi.waitFor(async () => expect((await lstat(socketPath)).isSocket()).toBe(true))

    await expect(requestLoginFromControlSocket(socketPath)).resolves.toEqual({
      ok: true,
      kind: 'connected',
    })
    await server.stop()
  })

  it('contains socket startup failure instead of throwing synchronously', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-control-file-'))
    temporaryDirectories.push(directory)
    const logger = { info: vi.fn(), warn: vi.fn() }
    const server = new WeixinControlServer(
      directory,
      vi.fn(async () => ({ kind: 'connected' as const })),
      logger,
    )

    expect(server.startInBackground()).toBeUndefined()
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled())
    await server.stop()
  })
})
