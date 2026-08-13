import { createInterface } from 'node:readline/promises'
import type { WeixinCredential } from './types.js'
import { delay } from './util.js'
import { requestQrJson } from './protocol.js'

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'
const BOT_TYPE = '3'
const QR_POLL_TIMEOUT_MS = 35_000
const MAX_QR_REFRESHES = 3

interface QrResponse {
  qrcode?: string
  qrcode_img_content?: string
}

type QrStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect'

interface StatusResponse {
  status?: QrStatus
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

/** QR-login callbacks kept injectable for deterministic protocol tests. */
export interface LoginCallbacks {
  showQr(url: string): Promise<void>
  readVerifyCode(prompt: string): Promise<string>
  status(message: string): void
}

/** Obtain an iLink credential through the official Weixin QR flow. */
export async function loginWithQr(options: {
  timeoutMs: number
  existingTokens?: string[]
  callbacks?: Partial<LoginCallbacks>
  fetchImpl?: typeof fetch
}): Promise<WeixinCredential> {
  const callbacks: LoginCallbacks = {
    showQr: options.callbacks?.showQr ?? displayQr,
    readVerifyCode: options.callbacks?.readVerifyCode ?? readVerifyCode,
    status: options.callbacks?.status ?? (message => process.stdout.write(`${message}\n`)),
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const deadline = Date.now() + options.timeoutMs
  let currentBaseUrl = FIXED_BASE_URL
  let refreshes = 0
  let pendingVerifyCode: string | undefined
  let scanned = false

  let qr = await fetchQr(options.existingTokens ?? [], fetchImpl)
  await callbacks.showQr(qr.url)
  callbacks.status('请用手机微信扫描二维码，并在微信中确认连接。')

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    let response: StatusResponse
    try {
      response = await pollStatus(
        currentBaseUrl,
        qr.id,
        pendingVerifyCode,
        Math.min(QR_POLL_TIMEOUT_MS, remaining),
        fetchImpl,
      )
    } catch (error) {
      if (isAbort(error)) {
        await delay(250)
        continue
      }
      callbacks.status(`二维码状态查询暂时失败，正在重试：${String(error)}`)
      await delay(1_000)
      continue
    }

    switch (response.status) {
      case 'wait':
        break
      case 'scaned':
        pendingVerifyCode = undefined
        if (!scanned) {
          callbacks.status('二维码已扫描，正在等待微信确认。')
          scanned = true
        }
        break
      case 'need_verifycode':
        pendingVerifyCode = await callbacks.readVerifyCode(
          pendingVerifyCode === undefined
            ? '请输入手机微信显示的数字：'
            : '数字不匹配，请重新输入：',
        )
        continue
      case 'scaned_but_redirect':
        currentBaseUrl = redirectBaseUrl(response.redirect_host)
        callbacks.status('已切换到微信分配的连接节点。')
        break
      case 'expired':
      case 'verify_code_blocked':
        refreshes += 1
        if (refreshes >= MAX_QR_REFRESHES) {
          throw new Error('微信二维码多次失效或验证码多次错误，请稍后重试')
        }
        pendingVerifyCode = undefined
        scanned = false
        qr = await fetchQr(options.existingTokens ?? [], fetchImpl)
        callbacks.status('二维码已刷新，请重新扫描。')
        await callbacks.showQr(qr.url)
        break
      case 'binded_redirect':
        throw new Error('这个微信 ClawBot 已绑定其他本地实例；请在微信中解除旧连接后重新扫码')
      case 'confirmed': {
        const token = response.bot_token?.trim()
        const accountId = response.ilink_bot_id?.trim()
        if (!token || !accountId) throw new Error('微信确认成功，但服务器没有返回完整登录凭据')
        const baseUrl = normalizeBaseUrl(response.baseurl?.trim() || currentBaseUrl)
        callbacks.status('微信连接授权成功。')
        return {
          token,
          accountId,
          baseUrl,
          ...(response.ilink_user_id?.trim() ? { userId: response.ilink_user_id.trim() } : {}),
        }
      }
      default:
        throw new Error(`微信二维码服务器返回未知状态：${String(response.status)}`)
    }
    await delay(1_000)
  }
  throw new Error('微信扫码登录超时，请重新启动后再试')
}

async function fetchQr(existingTokens: string[], fetchImpl: typeof fetch): Promise<{ id: string; url: string }> {
  const response = await requestQrJson(
    'POST',
    `${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
    15_000,
    { local_token_list: existingTokens.slice(-10).reverse() },
    fetchImpl,
  ) as QrResponse
  const id = response.qrcode?.trim()
  const url = response.qrcode_img_content?.trim()
  if (!id || !url) throw new Error('微信二维码服务器没有返回有效二维码')
  return { id, url }
}

function pollStatus(
  baseUrl: string,
  qrcode: string,
  verifyCode: string | undefined,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<StatusResponse> {
  const query = new URLSearchParams({ qrcode })
  if (verifyCode) query.set('verify_code', verifyCode)
  return requestQrJson(
    'GET',
    `${baseUrl}/ilink/bot/get_qrcode_status?${query.toString()}`,
    timeoutMs,
    undefined,
    fetchImpl,
  ) as Promise<StatusResponse>
}

/** Print the short-lived QR URL as both a terminal QR and a fallback link. */
export async function displayQr(url: string): Promise<void> {
  try {
    const qrcode = await import('qrcode-terminal')
    qrcode.default.generate(url, { small: true })
  } catch {
    // The fallback URL below remains usable when terminal rendering is unavailable.
  }
  process.stdout.write(`二维码备用链接（请勿转发）：\n${url}\n`)
}

async function readVerifyCode(prompt: string): Promise<string> {
  const input = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await input.question(prompt)).trim()
  } finally {
    input.close()
  }
}

function redirectBaseUrl(host: string | undefined): string {
  if (!host?.trim()) throw new Error('微信要求切换节点，但没有返回 redirect_host')
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) throw new Error('微信返回的 redirect_host 格式无效')
  return normalizeBaseUrl(`https://${host}`)
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('微信 iLink baseUrl 必须使用 HTTPS')
  return url.toString().replace(/\/+$/, '')
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}
