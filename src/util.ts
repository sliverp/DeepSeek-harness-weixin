import { createHash, randomBytes } from 'node:crypto'
import type { WeixinMessage } from './types.js'

// v1 may contain unparsed tool-call text; v2 may contain an open approval turn from an interactive policy.
const SESSION_NAMESPACE = 'weixin-v3-single'

/** Deterministic, non-identifying DSH session id for one Weixin user. */
export function sessionIdFor(accountId: string, message: Pick<WeixinMessage, 'from_user_id'>): string {
  const userId = message.from_user_id?.trim()
  if (!userId) throw new Error('Weixin message has no sender identifier')
  const digest = createHash('sha256').update(`${accountId}\0${userId}`).digest('hex').slice(0, 32)
  return `${SESSION_NAMESPACE}-${digest}`
}

/** Bound UTF-8 text without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number, suffix = '\n\n[回复已截断]'): string {
  const normalized = text.trim()
  if (Buffer.byteLength(normalized) <= maxBytes) return normalized
  const suffixBytes = Buffer.byteLength(suffix)
  const available = Math.max(0, maxBytes - suffixBytes)
  let result = ''
  let bytes = 0
  for (const codePoint of normalized) {
    const size = Buffer.byteLength(codePoint)
    if (bytes + size > available) break
    result += codePoint
    bytes += size
  }
  return result + (suffixBytes <= maxBytes ? suffix : '')
}

/** Promise timeout with a stable caller-facing label. */
export async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Abort-aware delay used by retry and cooldown paths. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/** Bounded insertion-ordered duplicate detector. */
export class SeenMessageIds {
  private readonly ids = new Set<string>()

  constructor(private readonly limit: number) {}

  /** Return true for a duplicate; record a new id otherwise. */
  hasOrAdd(id: string): boolean {
    if (this.ids.has(id)) return true
    this.ids.add(id)
    while (this.ids.size > this.limit) {
      const oldest = this.ids.values().next().value as string | undefined
      if (oldest === undefined) break
      this.ids.delete(oldest)
    }
    return false
  }
}

/** Stable message dedup key with fallbacks for incomplete protocol records. */
export function messageKey(message: WeixinMessage): string {
  if (message.message_id !== undefined) return String(message.message_id)
  if (message.client_id?.trim()) return message.client_id
  return createHash('sha256').update(JSON.stringify(message)).digest('hex')
}

/** Unique client id accepted by the iLink sendmessage endpoint. */
export function generateClientId(): string {
  return `dsh-weixin:${Date.now()}-${randomBytes(4).toString('hex')}`
}
