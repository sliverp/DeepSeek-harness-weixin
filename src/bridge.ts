import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { parseApprovalCommand } from './approvals.js'
import type { Config } from './config.js'
import { ConversationManager, type ConversationReply } from './conversations.js'
import { displayQr, loginWithQr } from './login.js'
import { filterMarkdownForWeixin } from './markdown-filter.js'
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

/** Injectable QR renderer used by terminal login and tests. */
export type WeixinQrDisplay = (url: string) => Promise<void>

/** Outcome of an explicit login request from a Harness command surface. */
export type WeixinLoginRequest = {
  kind: 'qr-shown'
  reused: boolean
  url: string
  /** Resolves only after authorization, credential persistence, and hot-switch finish. */
  completion: Promise<WeixinCredential>
}

type ConnectionReadiness =
  | { kind: 'connected' }
  | { kind: 'qr'; url: string }
  | { kind: 'failed'; error: unknown }

interface ConnectionAttempt {
  readonly forceQr: boolean
  readonly ready: Promise<ConnectionReadiness>
  readonly resolveReady: (readiness: ConnectionReadiness) => void
  displayQr: boolean
  task: Promise<WeixinCredential>
  qrUrl?: string
}

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
  private monitorAbortController: AbortController | undefined
  private disconnectTask: Promise<void> | undefined
  private connectionAttempt: ConnectionAttempt | undefined
  private connected = false
  private stopping = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly apiFactory: WeixinApiFactory = (credential, resolvedConfig) =>
      new WeixinApiClient(credential.baseUrl, credential.token, resolvedConfig),
    private readonly login: WeixinLogin = loginWithQr,
    private readonly showQr: WeixinQrDisplay = displayQr,
  ) {
    if (!isAbsolute(config.cwd)) throw new Error(`weixin-channel: cwd must be absolute, got ${JSON.stringify(config.cwd)}`)
    if (config.statePath && !isAbsolute(config.statePath)) {
      throw new Error(`weixin-channel: statePath must be absolute, got ${JSON.stringify(config.statePath)}`)
    }
    if (config.approvalTimeoutMs >= config.responseTimeoutMs) {
      throw new Error('weixin-channel: approvalTimeoutMs must be less than responseTimeoutMs')
    }
    this.log = ctx.logger('deepseek-harness-weixin')
    this.seen = new SeenMessageIds(config.maxSeenMessageIds)
  }

  /** Resolve or create a QR credential, verify it, and begin long-polling. */
  async start(): Promise<void> {
    if (this.connected) return
    await this.launchConnection(false, true).task
  }

  /** Begin connecting without making the containing Harness profile await QR login. */
  startInBackground(): void {
    if (this.connected || this.stopping) return
    this.launchConnection(false, true)
  }

  /** Force QR login, replacing any connected credential after authorization succeeds. */
  async requestLogin(signal?: AbortSignal, displayQr = true): Promise<WeixinLoginRequest> {
    throwIfAborted(signal)
    if (this.stopping) throw new Error('微信通道正在停止，无法发起扫码')

    let attempt = this.connectionAttempt
    if (attempt !== undefined && displayQr) attempt.displayQr = true
    if (attempt?.qrUrl !== undefined) {
      if (displayQr) await this.showQr(attempt.qrUrl)
      return { kind: 'qr-shown', reused: true, url: attempt.qrUrl, completion: attempt.task }
    }

    if (attempt === undefined) attempt = this.launchConnection(true, displayQr)
    let readiness = await waitFor(attempt.ready, signal)
    if (readiness.kind === 'qr') {
      return { kind: 'qr-shown', reused: false, url: readiness.url, completion: attempt.task }
    }

    // If a normal background restore wins the race, explicit login still starts
    // a fresh QR flow so the persisted credential can be replaced.
    if (!attempt.forceQr && !this.stopping) {
      attempt = this.launchConnection(true, displayQr)
      readiness = await waitFor(attempt.ready, signal)
      if (readiness.kind === 'qr') {
        return { kind: 'qr-shown', reused: false, url: readiness.url, completion: attempt.task }
      }
    }
    if (readiness.kind === 'connected') throw new Error('微信重新登录流程没有返回二维码')
    throw readiness.error
  }

  /** Abort long-polling and await all owned messages and agents. */
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.abortController.abort()
    const connectionTask = this.connectionAttempt?.task
    if (connectionTask !== undefined) await Promise.allSettled([connectionTask])
    await this.disconnectActive()
  }

  private launchConnection(forceQr: boolean, displayQr: boolean): ConnectionAttempt {
    if (this.stopping) throw new Error('微信通道正在停止，无法建立连接')
    if (this.connectionAttempt !== undefined) {
      if (displayQr) this.connectionAttempt.displayQr = true
      return this.connectionAttempt
    }

    let resolveReady!: (readiness: ConnectionReadiness) => void
    const ready = new Promise<ConnectionReadiness>(resolve => { resolveReady = resolve })
    let attempt!: ConnectionAttempt
    const task = Promise.resolve().then(() => this.connect(forceQr, attempt))
    attempt = {
      forceQr,
      ready,
      resolveReady,
      displayQr,
      task,
    }
    this.connectionAttempt = attempt
    void attempt.task.then(
      () => {
        attempt.resolveReady({ kind: 'connected' })
        if (this.connectionAttempt === attempt) this.connectionAttempt = undefined
      },
      error => {
        attempt.resolveReady({ kind: 'failed', error })
        if (this.connectionAttempt === attempt) this.connectionAttempt = undefined
        if (!this.stopping) {
          if (this.connected) {
            this.log.warn('Weixin re-login failed; the existing connection remains active: %s', String(error))
          } else {
            this.log.warn(
              'Weixin channel remains offline: %s. Harness Web is unaffected; run dsh-weixin login to show a fresh QR code.',
              String(error),
            )
          }
        }
      },
    )
    return attempt
  }

  private async connect(forceQr: boolean, attempt: ConnectionAttempt): Promise<WeixinCredential> {
    const credential = await this.resolveCredential(forceQr, attempt)
    throwIfAborted(this.abortController.signal)
    await this.disconnectActive()
    throwIfAborted(this.abortController.signal)
    const api = this.apiFactory(credential, this.config)
    const conversations = new ConversationManager(this.ctx, this.config, credential.accountId)
    let notified = false
    try {
      await conversations.initialize()
      throwIfAborted(this.abortController.signal)
      await api.notifyStart()
      notified = true
      throwIfAborted(this.abortController.signal)
    } catch (error) {
      await Promise.allSettled([
        conversations.dispose(),
        ...(notified ? [api.notifyStop()] : []),
      ])
      throw error
    }

    this.credential = credential
    this.api = api
    this.conversations = conversations
    this.connected = true
    const monitorAbortController = new AbortController()
    this.monitorAbortController = monitorAbortController
    this.log.info('Weixin iLink credential verified for account %s', shortId(credential.accountId))
    this.monitorTask = this.monitor(api, credential, monitorAbortController.signal).catch(error => {
      if (!this.stopping && !monitorAbortController.signal.aborted) {
        this.log.error('Weixin monitor stopped unexpectedly: %s', String(error))
      }
    })
    return credential
  }

  private async resolveCredential(forceQr: boolean, attempt: ConnectionAttempt): Promise<WeixinCredential> {
    const ref = credentialRef(this.config.credentialRef)
    if (!forceQr) {
      const resolved = await this.ctx.credentials.resolve(ref)
      if (resolved !== undefined) return parseCredential(resolved.value)
    }
    if (!forceQr && !this.config.autoLogin) {
      throw new Error(`weixin-channel: credential ${JSON.stringify(this.config.credentialRef)} is not configured`)
    }

    this.log.info(forceQr
      ? 'Starting explicitly requested Weixin QR login'
      : 'No Weixin credential found; starting official QR login')
    const credential = await this.login({
      timeoutMs: this.config.loginTimeoutMs,
      existingTokens: this.credential === undefined ? [] : [this.credential.token],
      signal: this.abortController.signal,
      callbacks: {
        showQr: async url => {
          attempt.qrUrl = url
          if (attempt.displayQr) await this.showQr(url)
          attempt.resolveReady({ kind: 'qr', url })
        },
        status: message => this.log.info('%s', message),
      },
    })
    throwIfAborted(this.abortController.signal)
    await this.ctx.credentials.set(ref, JSON.stringify(credential))
    this.log.info('Weixin credential stored by the Harness credential provider')
    return credential
  }

  private async monitor(api: WeixinApiPort, credential: WeixinCredential, signal: AbortSignal): Promise<void> {
    const cursorStore = new SyncCursorStore(resolveStatePath(this.config.statePath, credential.accountId))
    let cursor = await cursorStore.load()
    let timeoutMs = this.config.longPollTimeoutMs
    let failures = 0

    while (!signal.aborted) {
      try {
        const response = await api.getUpdates(cursor, timeoutMs, signal)
        if (signal.aborted) return
        const code = response.errcode ?? response.ret ?? 0
        if (code !== 0) {
          if (code === STALE_TOKEN_CODE) {
            this.log.error('Weixin credential is temporarily stale; pausing requests for %dms', this.config.staleTokenPauseMs)
            failures = 0
            await delay(this.config.staleTokenPauseMs, signal)
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
          await this.failureDelay(failures, signal)
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
        if (signal.aborted) return
        failures += 1
        this.log.error(
          'Weixin getUpdates transport failure (%d/%d): %s',
          failures,
          this.config.maxConsecutiveFailures,
          String(error),
        )
        await this.failureDelay(failures, signal)
        if (failures >= this.config.maxConsecutiveFailures) failures = 0
      }
    }
  }

  private async failureDelay(failures: number, signal: AbortSignal): Promise<void> {
    const ms = failures >= this.config.maxConsecutiveFailures
      ? this.config.backoffDelayMs
      : this.config.retryDelayMs
    await delay(ms, signal)
  }

  private disconnectActive(): Promise<void> {
    if (this.disconnectTask !== undefined) return this.disconnectTask
    const task = this.performDisconnectActive()
    this.disconnectTask = task
    void task.finally(() => {
      if (this.disconnectTask === task) this.disconnectTask = undefined
    }).catch(() => undefined)
    return task
  }

  private async performDisconnectActive(): Promise<void> {
    const monitorAbortController = this.monitorAbortController
    const monitorTask = this.monitorTask
    const conversations = this.conversations
    const api = this.api
    const credential = this.credential
    this.connected = false
    monitorAbortController?.abort(new Error('微信连接正在切换'))
    conversations?.cancelPendingApprovals()
    if (monitorTask !== undefined) await monitorTask
    await Promise.allSettled(this.inFlight)
    if (conversations !== undefined) await conversations.dispose()
    if (api !== undefined) {
      try {
        await api.notifyStop()
      } catch (error) {
        this.log.warn('Weixin notifyStop failed during teardown: %s', String(error))
      }
    }
    if (this.monitorAbortController === monitorAbortController) this.monitorAbortController = undefined
    if (this.monitorTask === monitorTask) this.monitorTask = undefined
    if (this.conversations === conversations) this.conversations = undefined
    if (this.api === api) this.api = undefined
    if (this.credential === credential) this.credential = undefined
  }

  private async dispatch(message: WeixinMessage, api: WeixinApiPort): Promise<void> {
    if (message.message_type !== undefined && message.message_type !== MessageType.USER) return
    const sender = message.from_user_id?.trim()
    if (!sender || !this.allowed(sender)) return
    if (this.seen.hasOrAdd(messageKey(message))) return
    const command = commandText(message)
    const bypassCapacity = command === '/bot-cancel'
      || command === '/new'
      || command === '/reset'
      || parseApprovalCommand(command) !== undefined
    while (!bypassCapacity && this.inFlight.size >= this.config.maxInFlightMessages && !this.stopping) {
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
    const approvalCommand = parseApprovalCommand(command)
    if (approvalCommand === 'invalid') {
      await this.sendReply(message, api, {
        text: '审批命令格式不正确。请回复 /approve 123456 或 /reject 123456。',
        images: [],
        files: [],
      })
      return
    }
    if (approvalCommand !== undefined) {
      const resolved = this.requireConversations().decideApproval(message, approvalCommand)
      const text = resolved === undefined
        ? `没有找到待处理的审批 ${approvalCommand.code}；它可能已完成、取消或超时。`
        : resolved.outcome === 'allowed-once'
          ? `已批准 ${resolved.toolName}（${resolved.code}），正在继续执行。`
          : `已拒绝 ${resolved.toolName}（${resolved.code}）。`
      await this.sendReply(message, api, { text, images: [], files: [] })
      return
    }
    if (command === '/new' || command === '/reset') {
      try {
        await this.requireConversations().startNewConversation(message)
        await this.sendReply(message, api, {
          text: '已开始新的 Harness 会话；旧 session 已保留，可继续在 Web 中查看。',
          images: [],
          files: [],
        })
      } catch (error) {
        this.log.error('Weixin new-session command failed: %s', String(error))
        await this.sendReply(message, api, { text: '创建新的 Harness 会话失败，请稍后重试。', images: [], files: [] })
      }
      return
    }
    if (command === '/bot-ping') {
      await this.sendReply(message, api, { text: 'pong — DeepSeek Harness 微信机器人已连接。', images: [], files: [] })
      return
    }
    if (command === '/bot-help') {
      await this.sendReply(message, api, {
        text: [
          'DeepSeek Harness 微信机器人',
          '/bot-ping — 检查连通性',
          '/bot-image-test — 发送蓝色图片，检查图片链路',
          '/bot-file-test — 发送文本文件，检查文件链路',
          '/bot-status — 查看当前连接状态',
          '/bot-cancel — 取消当前生成',
          '/new 或 /reset — 保留旧 session 并开始新会话',
          '/approve 123456 — 批准一次待处理工具调用',
          '/reject 123456 — 拒绝一次待处理工具调用',
          'Harness 注册的斜杠命令会直接交给命令运行时，不会发送给模型。',
          '其他消息会交给当前 Harness 默认模型处理。',
        ].join('\n'),
        images: [],
        files: [],
      })
      return
    }
    if (command === '/bot-image-test') {
      await this.sendReply(message, api, {
        text: '蓝色测试图片发送成功。',
        images: [{ data: OUTBOUND_TEST_PNG, mediaType: 'image/png', name: 'weixin-image-test.png' }],
        files: [],
      })
      return
    }
    if (command === '/bot-file-test') {
      await this.sendReply(message, api, {
        text: '文件测试发送成功。',
        images: [],
        files: [{ data: Buffer.from('DeepSeek Harness Weixin file delivery is working.\n'), name: 'weixin-file-test.txt' }],
      })
      return
    }
    if (command === '/bot-status') {
      await this.sendReply(message, api, {
        text: '微信 iLink 长轮询正常，DeepSeek Harness 会话按微信用户独立持久化。',
        images: [],
        files: [],
      })
      return
    }
    if (command === '/bot-cancel') {
      const cancelled = this.requireConversations().cancel(message)
      await this.sendReply(message, api, {
        text: cancelled ? '已请求取消当前生成。' : '当前没有正在生成的回复。',
        images: [],
        files: [],
      })
      return
    }

    const slashLine = messageText(message)
    if (parseCommand(slashLine) !== undefined) {
      try {
        const outcome = await this.requireConversations().executeCommand(
          message,
          slashLine,
          api,
          text => this.sendTextReply(message, api, text),
        )
        if (outcome.kind === 'handled') {
          await this.sendReply(message, api, outcome.reply)
        } else {
          const available = ['/new', '/reset', ...outcome.available]
          await this.sendReply(message, api, {
            text: `未知命令 ${JSON.stringify(slashLine.split(/\s/u, 1)[0])}。可用命令：${available.join('、') || '无'}。`,
            images: [],
            files: [],
          })
        }
      } catch (error) {
        this.log.error('Weixin Harness command failed: %s', String(error))
        await this.sendReply(message, api, { text: '执行 Harness 命令时发生错误，请稍后重试。', images: [], files: [] })
      }
      return
    }
    if (slashLine.startsWith('/')) {
      await this.sendReply(message, api, {
        text: '斜杠命令格式不正确；命令名只能使用小写字母、数字、下划线或连字符。',
        images: [],
        files: [],
      })
      return
    }

    try {
      const reply = await this.requireConversations().process(
        message,
        api,
        text => this.sendTextReply(message, api, text),
      )
      await this.sendReply(message, api, reply)
    } catch (error) {
      this.log.error('Weixin message processing failed: %s', String(error))
      try {
        await this.sendReply(message, api, { text: '处理消息时发生错误，请稍后重试。', images: [], files: [] })
      } catch (sendError) {
        this.log.error('Weixin error reply failed: %s', String(sendError))
      }
    }
  }

  private async sendReply(message: WeixinMessage, api: WeixinApiPort, reply: ConversationReply): Promise<void> {
    const to = message.from_user_id?.trim()
    if (!to) throw new Error('Weixin reply has no target user')
    const images = reply.images.slice(0, this.config.maxReplyImages)
    const filteredText = filterMarkdownForWeixin(reply.text)
    const text = truncateUtf8(
      filteredText.trim() ? filteredText : (images.length === 0 ? '处理完成。' : ''),
      this.config.maxReplyBytes,
    )
    if (text) {
      await this.sendTextReply(message, api, text)
    }
    for (const image of images) {
      await this.retry(() => api.sendImage(to, image.data, message.context_token))
    }
    for (const file of reply.files.slice(0, this.config.maxReplyFiles)) {
      await this.retry(() => api.sendFile(to, file.data, file.name, message.context_token))
    }
  }

  private async sendTextReply(message: WeixinMessage, api: WeixinApiPort, text: string): Promise<void> {
    const to = message.from_user_id?.trim()
    if (!to) throw new Error('Weixin reply has no target user')
    const bounded = truncateUtf8(text, this.config.maxReplyBytes)
    if (bounded) await this.retry(() => api.sendText(to, bounded, message.context_token))
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
  return messageText(message).toLowerCase()
}

function messageText(message: WeixinMessage): string {
  return (message.item_list ?? [])
    .filter(item => item.type === MessageItemType.TEXT)
    .map(item => item.text_item?.text ?? '')
    .join('\n')
    .trim()
}

function resolveStatePath(configured: string, accountId: string): string {
  if (configured) return configured
  const digest = createHash('sha256').update(accountId).digest('hex').slice(0, 16)
  return join(homedir(), '.dsh', 'weixin', `${digest}.sync.json`)
}

function shortId(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new Error(typeof signal.reason === 'string' ? signal.reason : '操作已取消')
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort)
      try {
        throwIfAborted(signal)
      } catch (error) {
        reject(error)
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}
