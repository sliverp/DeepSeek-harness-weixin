import { readFile, rm, stat, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loginStandalone } from '../src/standalone-login.js'
import type { WeixinCredential } from '../src/types.js'

const temporaryDirectories: string[] = []
const CREDENTIAL_REF = 'WEIXIN_TEST_ILINK_CREDENTIAL'
const OLD_CREDENTIAL: WeixinCredential = {
  token: 'old-token',
  accountId: 'old@im.bot',
  baseUrl: 'https://old.ilink.example',
}
const NEW_CREDENTIAL: WeixinCredential = {
  token: 'new-token',
  accountId: 'new@im.bot',
  userId: 'user@im.wechat',
  baseUrl: 'https://new.ilink.example',
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDshHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-standalone-'))
  temporaryDirectories.push(directory)
  vi.stubEnv('DSH_HOME', directory)
  return directory
}

describe('standalone Weixin login', () => {
  it('shows the QR before authorization and stores the credential through the Harness provider', async () => {
    const dshHome = await temporaryDshHome()
    let finishLogin!: (credential: WeixinCredential) => void
    const showQr = vi.fn(async () => undefined)
    const status = vi.fn()
    const login = vi.fn(async (options: {
      existingTokens?: string[]
      callbacks?: {
        showQr?: (url: string) => Promise<void>
        status?: (message: string) => void
        readVerifyCode?: (prompt: string, signal?: AbortSignal) => Promise<string>
      }
    }) => {
      expect(options.existingTokens).toEqual([])
      await options.callbacks?.showQr?.('https://qr.example/standalone')
      options.callbacks?.status?.('waiting')
      await expect(options.callbacks?.readVerifyCode?.('code:')).resolves.toBe('1234')
      return new Promise<WeixinCredential>(resolve => { finishLogin = resolve })
    })

    let finished = false
    const task = loginStandalone({
      credentialRef: CREDENTIAL_REF,
      timeoutMs: 300_000,
      showQr,
      status,
      readVerifyCode: vi.fn(async () => '1234'),
    }, login as never).finally(() => { finished = true })

    await vi.waitFor(() => expect(showQr).toHaveBeenCalledWith('https://qr.example/standalone'))
    expect(finished).toBe(false)
    finishLogin(NEW_CREDENTIAL)
    await expect(task).resolves.toEqual(NEW_CREDENTIAL)

    const filename = join(dshHome, '.credentials.yaml')
    expect((await stat(dshHome)).mode & 0o777).toBe(0o700)
    expect((await stat(filename)).mode & 0o777).toBe(0o600)
    const entries = parseCredentialsDocument(await readFile(filename, 'utf8'), filename)
    expect(JSON.parse(entries.get(CREDENTIAL_REF) ?? '')).toEqual(NEW_CREDENTIAL)
    expect(status).toHaveBeenCalledWith('waiting')
  })

  it('passes the old token to QR login and overwrites the stored credential', async () => {
    const dshHome = await temporaryDshHome()
    const initialLogin = vi.fn(async () => OLD_CREDENTIAL)
    const options = {
      credentialRef: CREDENTIAL_REF,
      timeoutMs: 300_000,
      showQr: vi.fn(async () => undefined),
      status: vi.fn(),
    }
    await loginStandalone(options, initialLogin as never)

    const replacementLogin = vi.fn(async (loginOptions: { existingTokens?: string[] }) => {
      expect(loginOptions.existingTokens).toEqual([OLD_CREDENTIAL.token])
      return NEW_CREDENTIAL
    })
    await expect(loginStandalone(options, replacementLogin as never)).resolves.toEqual(NEW_CREDENTIAL)

    const filename = join(dshHome, '.credentials.yaml')
    const entries = parseCredentialsDocument(await readFile(filename, 'utf8'), filename)
    expect(JSON.parse(entries.get(CREDENTIAL_REF) ?? '')).toEqual(NEW_CREDENTIAL)
  })

  it('refuses to pretend it can overwrite a credential supplied by the process environment', async () => {
    await temporaryDshHome()
    vi.stubEnv(CREDENTIAL_REF, JSON.stringify(OLD_CREDENTIAL))
    const login = vi.fn(async () => NEW_CREDENTIAL)

    await expect(loginStandalone({
      credentialRef: CREDENTIAL_REF,
      timeoutMs: 300_000,
      showQr: vi.fn(async () => undefined),
      status: vi.fn(),
    }, login as never)).rejects.toThrow('无法被登录命令覆盖')
    expect(login).not.toHaveBeenCalled()
  })
})
