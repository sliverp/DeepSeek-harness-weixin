import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Config } from './config.js'
import { ConversationManager, type ConversationReply } from './conversations.js'
import { loginWithQr } from './login.js'
import { WeixinApiClient, type WeixinApiPort } from './protocol.js'
import { SyncCursorStore } from './state.js'
import {
  MessageItemType,
  MessageType,
  parseCredential,
  type WeixinCredential,
  type WeixinMessage,
} from './types.js'
import { delay, messageKey, SeenMessageIds, truncateUtf8 } from './util.js'

const STALE_TOKEN_CODE = -14
const OUTBOUND_TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAYAAADDhn8LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAACn0lEQVR4nO3XsZFCQRDEUDIhxA28g1gS4JwrCmQ8QwmoR/vh8Ty74MAN7K2DBzHicAP704FABCKQIxBH4CG4/3HgC+JwPB5HII7AQ3B9QRyBh+B81oGfWKIS1RGII/AQXF8QR+AhOH5iOQIPwf2WA/9BHJsH5wjEEXgIri+II/AQHD+xHIGH4PoP4gg8BOf3DvxJD4yAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwAroOBBIYAcs6EEhgBCzrQCCBEbCsA4EERsCyDgQSGAHLOhBIYAQs60AggRGwrAOBBEbAsg4EEhgByzoQSGAELOtAIIERsKwDgQRGwLIOBBIYAcs6EEhgBCzrQCCBEbCsA4EERsCyDgQSGAHLOhBIYAQs60AggRGwrAOBBEbAsg4EEhgBCzr4AVwXepBk5abggAAAAABJRU5ErkJggg==',
  'base64',
)

/** Injectable production API factory. */
export type WeixinApiFactory = (credential: WeixinCredential, config: Config) => WeixinApiPort

/** Injectable QR login operation. */
export type WeixinLogin = typeof loginWithQr

/** Live Weixin iLink long-poll ↔ DeepSeek Harness bridge. */
export class WeixinHarnessBridge {
  private readonly log
  private readonly seen: SeenMessageIds
  private readonly abortController = new AbortController()
  private readonly inFlight = new Set<Promise<void>>()
  private credential: WeixinCredential | undefined
  private api: WeixinApiPort | undefined
  private conversations: ConversationManager | undefined
  private monitorTask: Promise<void> | undefined
  private stopping = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly apiFactory: WeixinApiFactory = (credential, resolvedConfig) =>
      new WeixinApiClient(credential.baseUrl, credential.token, resolvedConfig),
    private readonly login: WeixinLogin = loginWithQr,
  ) {
    if (!isAbsolute(config.cwd)) throw new Error(`weixin-channel: cwd must be absolute, got ${JSON.stringify(config.cwd)}`)
    if (config.statePath && !isAbsolute(config.statePath)) {
      throw new Error(`weixin-channel: statePath must be absolute, got ${JSON.stringify(config.statePath)}`)
    }
    this.log = ctx.logger('deepseek-harness-weixin')
    this.seen = new SeenMessageIds(config.maxSeenMessageIds)
  }

  /** Resolve or create a QR credential, verify it, and begin long-polling. */
  async start(): Promise<void> {
    const credential = await this.resolveCredential()
    this.credential = credential
    const api = this.apiFactory(credential, this.config)
    this.api = api
    const conversations = new ConversationManager(this.ctx, this.config, credential.accountId)
    this.conversations = conversations
    await conversations.initialize()
    await api.notifyStart()
    this.log.info('Weixin iLink credential verified for account %s', shortId(credential.accountId))
    this.monitorTask = this.monitor(api, credential).catch(error => {
      if (!this.stopping) this.log.error('Weixin monitor stopped unexpectedly: %s', String(error))
    })
  }

  /** Abort long-polling and await all owned messages and agents. */
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.abortController.abort()
    if (this.monitorTask !== undefined) await this.monitorTask
    await Promise.allSettled(this.inFlight)
    if (this.conversations !== undefined) await this.conversations.dispose()
    if (this.api !== undefined) {
      try {
        await this.api.notifyStop()
      } catch (error) {
        this.log.warn('Weixin notifyStop failed during teardown: %s', String(error))
      }
    }
  }

  private async resolveCredential(): Promise<WeixinCredential> {
    const ref = credentialRef(this.config.credentialRef)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved !== undefined) return parseCredential(resolved.value)
    if (!this.config.autoLogin) {
      throw new Error(`weixin-channel: credential ${JSON.stringify(this.config.credentialRef)} is not configured`)
    }

    this.log.info('No Weixin credential found; starting official QR login')
    const credential = await this.login({
      timeoutMs: this.config.loginTimeoutMs,
      callbacks: { status: message => this.log.info('%s', message) },
    })
    await this.ctx.credentials.set(ref, JSON.stringify(credential))
    this.log.info('Weixin credential stored by the Harness credential provider')
    return credential
  }

  private async monitor(api: WeixinApiPort, credential: WeixinCredential): Promise<void> {
    const cursorStore = new SyncCursorStore(resolveStatePath(this.config.statePath, credential.accountId))
    let cursor = await cursorStore.load()
    let timeoutMs = this.config.longPollTimeoutMs
    let failures = 0

    while (!this.abortController.signal.aborted) {
      try {
        const response = await api.getUpdates(cursor, timeoutMs, this.abortController.signal)
        if (this.abortController.signal.aborted) return
        const code = response.errcode ?? response.ret ?? 0
        if (code !== 0) {
          if (code === STALE_TOKEN_CODE) {
            this.log.error('Weixin credential is temporarily stale; pausing requests for %dms', this.config.staleTokenPauseMs)
            failures = 0
            await delay(this.config.staleTokenPauseMs, this.abortController.signal)
            continue
          }
          failures += 1
          this.log.error(
            'Weixin getUpdates failed with code %d (%d/%d): %s',
            code,
            failures,
            this.config.maxConsecutiveFailures,
            response.errmsg ?? '(no message)',
          )
          await this.failureDelay(failures)
          if (failures >= this.config.maxConsecutiveFailures) failures = 0
          continue
        }
        failures = 0
        if (response.longpolling_timeout_ms !== undefined && response.longpolling_timeout_ms > 0) {
          timeoutMs = Math.max(1_000, Math.min(response.longpolling_timeout_ms, 120_000))
        }
        if (response.get_updates_buf !== undefined && response.get_updates_buf !== '' && response.get_updates_buf !== cursor) {
          await cursorStore.save(response.get_updates_buf)
          cursor = response.get_updates_buf
        }
        for (const message of response.msgs ?? []) await this.dispatch(message, api)
      } catch (error) {
        if (this.abortController.signal.aborted) return
        failures += 1
        this.log.error(
          'Weixin getUpdates transport failure (%d/%d): %s',
          failures,
          this.config.maxConsecutiveFailures,
          String(error),
        )
        await this.failureDelay(failures)
        if (failures >= this.config.maxConsecutiveFailures) failures = 0
      }
    }
  }

  private async failureDelay(failures: number): Promise<void> {
    const ms = failures >= this.config.maxConsecutiveFailures
      ? this.config.backoffDelayMs
      : this.config.retryDelayMs
    await delay(ms, this.abortController.signal)
  }

  private async dispatch(message: WeixinMessage, api: WeixinApiPort): Promise<void> {
    if (message.message_type !== undefined && message.message_type !== MessageType.USER) return
    if (!message.from_user_id?.trim() || !this.allowed(message.from_user_id)) return
    if (this.seen.hasOrAdd(messageKey(message))) return
    while (this.inFlight.size >= this.config.maxInFlightMessages && !this.stopping) {
      await Promise.race(this.inFlight)
    }
    if (this.stopping) return
    const task = this.handleMessage(message, api).catch(error => {
      this.log.error('Weixin message %s failed: %s', messageKey(message), String(error))
    })
    const tracked = task.finally(() => this.inFlight.delete(tracked))
    this.inFlight.add(tracked)
  }

  private allowed(sender: string): boolean {
    if (this.config.accessPolicy === 'disabled') return false
    return this.config.accessPolicy === 'open' || this.config.allowFrom.includes(sender)
  }

  private async handleMessage(message: WeixinMessage, api: WeixinApiPort): Promise<void> {
    const command = commandText(message)
    if (command === '/bot-ping') {
      await this.sendReply(message, api, { text: 'pong — DeepSeek Harness 微信机器人已连接。', images: [] })
      return
    }
    if (command === '/bot-help') {
      await this.sendReply(message, api, {
        text: [
          'DeepSeek Harness 微信机器人',
          '/bot-ping — 检查连通性',
          '/bot-image-test — 发送蓝色图片，检查图片链路',
          '/bot-status — 查看当前连接状态',
          '/bot-cancel — 取消当前生成',
          '其他消息会交给当前 Harness 默认模型处理。',
        ].join('\n'),
        images: [],
      })
      return
    }
    if (command === '/bot-image-test') {
      await this.sendReply(message, api, {
        text: '蓝色测试图片发送成功。',
        images: [{ data: OUTBOUND_TEST_PNG, mediaType: 'image/png', name: 'weixin-image-test.png' }],
      })
      return
    }
    if (command === '/bot-status') {
      await this.sendReply(message, api, {
        text: '微信 iLink 长轮询正常，DeepSeek Harness 会话按微信用户独立持久化。',
        images: [],
      })
      return
    }
    if (command === '/bot-cancel') {
      const cancelled = this.requireConversations().cancel(message)
      await this.sendReply(message, api, {
        text: cancelled ? '已请求取消当前生成。' : '当前没有正在生成的回复。',
        images: [],
      })
      return
    }

    try {
      const reply = await this.requireConversations().process(message, api)
      await this.sendReply(message, api, reply)
    } catch (error) {
      this.log.error('Weixin message processing failed: %s', String(error))
      try {
        await this.sendReply(message, api, { text: '处理消息时发生错误，请稍后重试。', images: [] })
      } catch (sendError) {
        this.log.error('Weixin error reply failed: %s', String(sendError))
      }
    }
  }

  private async sendReply(message: WeixinMessage, api: WeixinApiPort, reply: ConversationReply): Promise<void> {
    const to = message.from_user_id?.trim()
    if (!to) throw new Error('Weixin reply has no target user')
    const images = reply.images.slice(0, this.config.maxReplyImages)
    const text = truncateUtf8(reply.text || (images.length === 0 ? '处理完成。' : ''), this.config.maxReplyBytes)
    if (text) {
      await this.retry(() => api.sendText(to, text, message.context_token))
    }
    for (const image of images) {
      await this.retry(() => api.sendImage(to, image.data, message.context_token))
    }
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.config.sendRetries; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        lastError = error
        if (attempt < this.config.sendRetries) await delay(250 * (attempt + 1), this.abortController.signal)
      }
    }
    throw lastError
  }

  private requireConversations(): ConversationManager {
    if (this.conversations === undefined) throw new Error('weixin-channel: conversations are not initialized')
    return this.conversations
  }
}

function commandText(message: WeixinMessage): string {
  return (message.item_list ?? [])
    .filter(item => item.type === MessageItemType.TEXT)
    .map(item => item.text_item?.text ?? '')
    .join('\n')
    .trim()
    .toLowerCase()
}

function resolveStatePath(configured: string, accountId: string): string {
  if (configured) return configured
  const digest = createHash('sha256').update(accountId).digest('hex').slice(0, 16)
  return join(homedir(), '.dsh', 'weixin', `${digest}.sync.json`)
}

function shortId(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12)
}
