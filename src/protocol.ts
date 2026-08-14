import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { Config } from './config.js'
import {
  MessageItemType,
  MessageState,
  MessageType,
  UploadMediaType,
  type BaseInfo,
  type GetUpdatesResponse,
  type ImageItem,
  type MessageItem,
  type WeixinMessage,
} from './types.js'
import { generateClientId } from './util.js'

const CHANNEL_VERSION = '0.2.2'
const BOT_AGENT = 'DeepSeek-Harness/0.2.2'
const ILINK_APP_ID = 'bot'
// Protocol compatibility level of Tencent/openclaw-weixin v2.4.6.
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

type FetchPort = typeof fetch

/** iLink operations used by monitoring, inbound media, and replies. */
export interface WeixinApiPort {
  getUpdates(cursor: string, timeoutMs: number, signal?: AbortSignal): Promise<GetUpdatesResponse>
  notifyStart(): Promise<void>
  notifyStop(): Promise<void>
  sendText(to: string, text: string, contextToken?: string): Promise<void>
  sendImage(to: string, data: Uint8Array, contextToken?: string): Promise<void>
  downloadImage(image: ImageItem, timeoutMs: number): Promise<Buffer>
}

/** Official iLink JSON/CDN client derived from Tencent/openclaw-weixin 2.4.6. */
export class WeixinApiClient implements WeixinApiPort {
  private readonly cdnBaseUrl = DEFAULT_CDN_BASE_URL

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly config: Pick<Config, 'apiTimeoutMs' | 'sendRetries' | 'maxOutboundImageBytes'>,
    private readonly fetchImpl: FetchPort = fetch,
  ) {}

  async getUpdates(cursor: string, timeoutMs: number, signal?: AbortSignal): Promise<GetUpdatesResponse> {
    try {
      return await this.postJson('ilink/bot/getupdates', {
        get_updates_buf: cursor,
        base_info: baseInfo(),
      }, timeoutMs, 'getUpdates', signal) as GetUpdatesResponse
    } catch (error) {
      if (isAbort(error)) return { ret: 0, msgs: [], get_updates_buf: cursor }
      throw error
    }
  }

  async notifyStart(): Promise<void> {
    const response = await this.postJson(
      'ilink/bot/msg/notifystart',
      { base_info: baseInfo() },
      this.config.apiTimeoutMs,
      'notifyStart',
    ) as { ret?: number; errcode?: number; errmsg?: string }
    assertSuccess(response, 'notifyStart')
  }

  async notifyStop(): Promise<void> {
    const response = await this.postJson(
      'ilink/bot/msg/notifystop',
      { base_info: baseInfo() },
      this.config.apiTimeoutMs,
      'notifyStop',
    ) as { ret?: number; errcode?: number; errmsg?: string }
    assertSuccess(response, 'notifyStop')
  }

  async sendText(to: string, text: string, contextToken?: string): Promise<void> {
    const item: MessageItem = { type: MessageItemType.TEXT, text_item: { text } }
    await this.sendItem(to, item, contextToken)
  }

  async sendImage(to: string, data: Uint8Array, contextToken?: string): Promise<void> {
    const plaintext = Buffer.from(data)
    if (plaintext.byteLength > this.config.maxOutboundImageBytes) {
      throw new Error(`Weixin outbound image exceeds the ${this.config.maxOutboundImageBytes}-byte limit`)
    }
    const key = randomBytes(16)
    const filekey = randomBytes(16).toString('hex')
    const encrypted = encryptAesEcb(plaintext, key)
    const upload = await this.postJson('ilink/bot/getuploadurl', {
      filekey,
      media_type: UploadMediaType.IMAGE,
      to_user_id: to,
      rawsize: plaintext.byteLength,
      rawfilemd5: createHash('md5').update(plaintext).digest('hex'),
      filesize: encrypted.byteLength,
      no_need_thumb: true,
      aeskey: key.toString('hex'),
      base_info: baseInfo(),
    }, this.config.apiTimeoutMs, 'getUploadUrl') as {
      upload_param?: string
      upload_full_url?: string
    }
    const uploadUrl = upload.upload_full_url?.trim()
      || (upload.upload_param
        ? `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}`
        : '')
    if (!uploadUrl) throw new Error('getUploadUrl returned no CDN upload URL')
    const downloadParam = await this.uploadEncrypted(uploadUrl, encrypted)
    await this.sendItem(to, {
      type: MessageItemType.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: downloadParam,
          aes_key: Buffer.from(key.toString('hex')).toString('base64'),
          encrypt_type: 1,
        },
        mid_size: encrypted.byteLength,
      },
    }, contextToken)
  }

  async downloadImage(image: ImageItem, timeoutMs: number): Promise<Buffer> {
    const media = image.media
    if (media === undefined) throw new Error('Weixin image has no CDN media reference')
    const encryptedQuery = media.encrypt_query_param ?? ''
    const url = media.full_url?.trim()
      || (encryptedQuery
        ? `${this.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQuery)}`
        : '')
    if (!url) throw new Error('Weixin image has no CDN download URL')
    const response = await fetchWithTimeout(this.fetchImpl, url, { method: 'GET' }, timeoutMs)
    if (!response.ok) throw new Error(`Weixin CDN download failed with HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const key = image.aeskey?.trim()
      ? parseHexKey(image.aeskey)
      : media.aes_key?.trim()
        ? parseBase64Key(media.aes_key)
        : undefined
    return key === undefined ? bytes : decryptAesEcb(bytes, key)
  }

  private async sendItem(to: string, item: MessageItem, contextToken?: string): Promise<void> {
    const response = await this.postJson('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        ...(contextToken === undefined ? {} : { context_token: contextToken }),
      } satisfies WeixinMessage,
      base_info: baseInfo(),
    }, this.config.apiTimeoutMs, 'sendMessage') as { ret?: number; errcode?: number; errmsg?: string }
    assertSuccess(response, 'sendMessage')
  }

  private async uploadEncrypted(url: string, encrypted: Buffer): Promise<string> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.config.sendRetries; attempt += 1) {
      try {
        const response = await fetchWithTimeout(this.fetchImpl, url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(encrypted),
        }, this.config.apiTimeoutMs)
        if (!response.ok) throw new Error(`Weixin CDN upload failed with HTTP ${response.status}`)
        const param = response.headers.get('x-encrypted-param')
        if (!param) throw new Error('Weixin CDN upload response has no x-encrypted-param')
        return param
      } catch (error) {
        lastError = error
        if (attempt < this.config.sendRetries) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
    throw lastError
  }

  private postJson(
    endpoint: string,
    body: unknown,
    timeoutMs: number,
    label: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return requestJson(this.fetchImpl, {
      url: new URL(endpoint, ensureTrailingSlash(this.baseUrl)).toString(),
      method: 'POST',
      headers: authenticatedHeaders(this.token),
      body,
      timeoutMs,
      label,
      ...(signal === undefined ? {} : { signal }),
    })
  }
}

/** Unauthenticated QR endpoint request used by the login flow. */
export function requestQrJson(
  method: 'GET' | 'POST',
  url: string,
  timeoutMs: number,
  body?: unknown,
  fetchImpl: FetchPort = fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson(fetchImpl, {
    url,
    method,
    headers: commonHeaders(),
    ...(body === undefined ? {} : { body }),
    timeoutMs,
    label: 'Weixin QR login',
    ...(signal === undefined ? {} : { signal }),
  })
}

function requestJson(fetchImpl: FetchPort, options: {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: unknown
  timeoutMs: number
  label: string
  signal?: AbortSignal
}): Promise<unknown> {
  return (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    const abort = (): void => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await fetchImpl(options.url, {
        method: options.method,
        headers: options.headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`${options.label} failed with HTTP ${response.status}`)
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new Error(`${options.label} returned invalid JSON`)
      }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  })()
}

async function fetchWithTimeout(
  fetchImpl: FetchPort,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function baseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }
}

function commonHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  }
}

function authenticatedHeaders(token: string): Record<string, string> {
  const uin = randomBytes(4).readUInt32BE(0)
  return {
    ...commonHeaders(),
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': Buffer.from(String(uin)).toString('base64'),
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function assertSuccess(response: { ret?: number; errcode?: number; errmsg?: string }, label: string): void {
  const code = response.errcode ?? response.ret ?? 0
  if (code !== 0) throw new Error(`${label} failed with iLink code ${code}: ${response.errmsg ?? '(no message)'}`)
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function parseHexKey(value: string): Buffer {
  if (!/^[0-9a-fA-F]{32}$/.test(value)) throw new Error('Weixin image AES hex key is invalid')
  return Buffer.from(value, 'hex')
}

function parseBase64Key(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 16) return decoded
  const ascii = decoded.toString('ascii')
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, 'hex')
  throw new Error('Weixin image AES key has an invalid length')
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}
