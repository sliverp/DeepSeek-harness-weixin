import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { Config } from './config.js'
import { inboundContent } from './inbound.js'
import type { WeixinApiPort } from './protocol.js'
import type { WeixinMessage } from './types.js'
import { sessionIdFor, withTimeout } from './util.js'

/** Completed response from one Weixin-triggered Harness turn. */
export interface ConversationReply {
  text: string
  images: Array<{ data: Uint8Array; mediaType: string; name?: string }>
}

/** Owns deterministic Weixin conversation agents and persisted resume lifecycle. */
export class ConversationManager {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly creations = new Map<string, Promise<AgentHandle>>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private persistedIds = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly accountId: string,
  ) {}

  /** Snapshot persisted identities once before accepting traffic. */
  async initialize(): Promise<void> {
    const headers = await this.ctx.sessionPersistence.list()
    this.persistedIds = new Set(headers.map(header => String(header.id)))
  }

  /** Process one inbound message after earlier work for the same Weixin user. */
  process(message: WeixinMessage, api: WeixinApiPort): Promise<ConversationReply> {
    const id = sessionIdFor(this.accountId, message)
    const previous = this.queues.get(id) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.processNow(id, message, api))
    const tracked = current.finally(() => {
      if (this.queues.get(id) === tracked) this.queues.delete(id)
    })
    this.queues.set(id, tracked)
    return current
  }

  /** Cancel active work for one Weixin user. */
  cancel(message: WeixinMessage): boolean {
    const id = sessionIdFor(this.accountId, message)
    const agent = this.handles.get(id)?.agent ?? this.ctx.agents.get(SessionId(id))
    if (agent === undefined || agent.status === 'idle') return false
    agent.cancel({ kind: 'user' })
    return true
  }

  /** Dispose every bridge-owned Agent after queued work settles. */
  async dispose(): Promise<void> {
    await Promise.allSettled(this.queues.values())
    await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
    this.handles.clear()
  }

  private async processNow(id: string, message: WeixinMessage, api: WeixinApiPort): Promise<ConversationReply> {
    const handle = await this.getOrCreate(id)
    const agent = handle.agent
    const start = agent.session.events.length
    const content = await inboundContent(this.ctx, this.config, api, message, await this.includeImages(agent))
    agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
    await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness response')
    return this.collectReply(agent, agent.session.events.slice(start))
  }

  private async includeImages(agent: Agent): Promise<boolean> {
    if (this.config.imageInputMode === 'always') return true
    if (this.config.imageInputMode === 'never') return false
    const { provider, model } = agent.options
    if (provider === undefined || model === undefined) return false
    const info = await this.ctx.llm.resolveModelInfo(provider, model)
    return info.inputModalities?.includes('image') ?? false
  }

  private async getOrCreate(id: string): Promise<AgentHandle> {
    const existing = this.handles.get(id)
    if (existing !== undefined) return existing
    const pending = this.creations.get(id)
    if (pending !== undefined) return pending
    const creation = this.createOrResume(id).finally(() => this.creations.delete(id))
    this.creations.set(id, creation)
    const handle = await creation
    this.handles.set(id, handle)
    return handle
  }

  private async createOrResume(id: string): Promise<AgentHandle> {
    const sessionId = SessionId(id)
    const current = this.ctx.agentDefaultModel.currentSelection()
    const agentOptions = { provider: current.provider, model: current.model }
    if (this.persistedIds.has(id)) {
      return this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
    }
    const handle = await this.ctx.agents.create({ sessionId, meta: { cwd: this.config.cwd }, agentOptions })
    this.persistedIds.add(id)
    handle.agent.inject(createUserMessage({
      content: [{ type: 'text', text: this.config.systemPrompt }],
      source: { kind: 'plugin', plugin: 'deepseek-harness-weixin', form: 'instructions' },
    }))
    return handle
  }

  private async collectReply(agent: Agent, events: readonly SessionEvent[]): Promise<ConversationReply> {
    const texts: string[] = []
    const images: ConversationReply['images'] = []
    for (const event of events) {
      if (event.type !== 'assistant/message') continue
      for (const block of event.data.message.content) {
        if (block.type === 'text' && block.text.trim()) texts.push(block.text.trim())
        if (block.type === 'image') {
          const stored = await this.ctx.attachments.readImage(block.attachment)
          images.push({
            data: stored.data,
            mediaType: stored.ref.mediaType,
            ...(stored.ref.name === undefined ? {} : { name: stored.ref.name }),
          })
        }
      }
    }
    const finalTurn = [...events].reverse().find(event => event.type === 'turn/end')
    if (texts.length === 0 && finalTurn?.type === 'turn/end' && finalTurn.data.reason.kind === 'error') {
      return { text: `处理失败（${finalTurn.data.reason.error.code}），请稍后重试。`, images }
    }
    if (texts.length === 0 && images.length === 0) {
      return { text: '处理完成，但没有生成可发送的内容。', images }
    }
    return { text: texts.join('\n\n'), images }
  }
}
