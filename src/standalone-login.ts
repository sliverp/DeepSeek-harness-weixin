import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { loginWithQr, type LoginCallbacks } from './login.js'
import { parseCredential, type WeixinCredential } from './types.js'

export interface StandaloneLoginOptions {
  credentialRef: string
  timeoutMs: number
  showQr(url: string): Promise<void>
  status(message: string): void
  readVerifyCode?(prompt: string, signal?: AbortSignal): Promise<string>
  signal?: AbortSignal
}

/** Injectable QR operation for standalone CLI tests. */
export type StandaloneQrLogin = typeof loginWithQr

/**
 * Complete QR authorization without a running Harness composition and commit
 * the result through Harness's own locked, atomic local credential provider.
 */
export async function loginStandalone(
  options: StandaloneLoginOptions,
  login: StandaloneQrLogin = loginWithQr,
): Promise<WeixinCredential> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, { watch: false })
  await fiber
  try {
    const ref = credentialRef(options.credentialRef)
    const info = await ctx.credentials.describe(ref)
    if (!info.writable) {
      throw new Error(`凭据 ${options.credentialRef} 由启动环境提供，无法被登录命令覆盖`)
    }
    const existing = await ctx.credentials.resolve(ref)
    const existingTokens = existing === undefined ? [] : credentialTokens(existing.value)
    const callbacks: Partial<LoginCallbacks> = {
      showQr: options.showQr,
      status: options.status,
      ...(options.readVerifyCode === undefined ? {} : { readVerifyCode: options.readVerifyCode }),
    }
    const credential = await login({
      timeoutMs: options.timeoutMs,
      existingTokens,
      callbacks,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    await ctx.credentials.set(ref, JSON.stringify(credential))
    return credential
  } finally {
    await fiber.dispose()
  }
}

function credentialTokens(value: string): string[] {
  try {
    return [parseCredential(value).token]
  } catch {
    // A malformed old value must not prevent a fresh QR flow from repairing it.
    return []
  }
}
