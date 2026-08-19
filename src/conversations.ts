import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import {
  WeixinApprovalRegistry,
  type ApprovalCommand,
  type ResolvedApproval,
} from './approvals.js'
import type { Config } from './config.js'
import { inboundContent } from './inbound.js'
import { collectOutboundFiles, type OutboundFile } from './outbound-files.js'
import type { WeixinApiPort } from './protocol.js'
import type { WeixinMessage } from './types.js'
import { sessionIdFor, withTimeout } from './util.js'

/** Completed response from one Weixin-triggered Harness turn. */
export interface ConversationReply {
  text: string
  images: Array<{ data: Uint8Array; mediaType: string; name?: string }>
  files: OutboundFile[]
}

/** Result of dispatching one syntactically valid Harness slash command. */
export type ConversationCommandOutcome =
  | { kind: 'handled'; reply: ConversationReply }
  | { kind: 'unknown'; available: string[] }

/** One live Agent plus only the lifecycle capability this manager owns. */
interface ConversationAgentBinding {
  agent: Agent
  release(): Promise<void>
}

/** Owns deterministic Weixin conversation agents and persisted resume lifecycle. */
export class ConversationManager {
  private readonly bindings = new Map<string, ConversationAgentBinding>()
  private readonly creations = new Map<string, Promise<ConversationAgentBinding>>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly activeIds = new Map<string, string>()
  private readonly rotations = new Map<string, Promise<unknown>>()
  private readonly approvals: WeixinApprovalRegistry
  private persistedIds = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly accountId: string,
  ) {
    this.approvals = new WeixinApprovalRegistry(config.approvalTimeoutMs)
  }

  /** Snapshot persisted identities once before accepting traffic. */
  async initialize(): Promise<void> {
    if (this.config.permissionPreset !== undefined) {
      this.ctx.permissionPresets.resolve(this.config.permissionPreset)
    }
    const headers = await this.ctx.sessionPersistence.list()
    this.persistedIds = new Set(headers.map(header => String(header.id)))
  }

  /** Process one inbound message after earlier work for the same Weixin user. */
  process(
    message: WeixinMessage,
    api: WeixinApiPort,
    sendApprovalPrompt?: (text: string) => Promise<void>,
  ): Promise<ConversationReply> {
    const baseId = sessionIdFor(this.accountId, message)
    const rotation = this.rotations.get(baseId) ?? Promise.resolve()
    return rotation.catch(() => undefined).then(() => {
      const id = this.activeIdFor(baseId)
      return this.enqueue(id, () => this.processNow(id, message, api, sendApprovalPrompt))
    })
  }

  /** Execute a registered Harness slash command without sending it to the model. */
  executeCommand(
    message: WeixinMessage,
    line: string,
    api: WeixinApiPort,
    sendApprovalPrompt?: (text: string) => Promise<void>,
  ): Promise<ConversationCommandOutcome> {
    const baseId = sessionIdFor(this.accountId, message)
    const rotation = this.rotations.get(baseId) ?? Promise.resolve()
    return rotation.catch(() => undefined).then(() => {
      const id = this.activeIdFor(baseId)
      return this.enqueue(id, () => this.executeCommandNow(id, message, line, api, sendApprovalPrompt))
    })
  }

  /** Rotate one Weixin conversation to a fresh persistent Agent session. */
  startNewConversation(message: WeixinMessage): Promise<void> {
    const baseId = sessionIdFor(this.accountId, message)
    const previous = this.rotations.get(baseId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.rotateConversation(baseId))
    const tracked = current.then(() => undefined, () => undefined).finally(() => {
      if (this.rotations.get(baseId) === tracked) this.rotations.delete(baseId)
    })
    this.rotations.set(baseId, tracked)
    return current
  }

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const current = previous.catch(() => undefined)
      .then(operation)
    const tracked = current.then(() => undefined, () => undefined).finally(() => {
      if (this.queues.get(id) === tracked) this.queues.delete(id)
    })
    this.queues.set(id, tracked)
    return current
  }

  /** Cancel active work for one Weixin user. */
  cancel(message: WeixinMessage): boolean {
    const id = this.activeIdFor(sessionIdFor(this.accountId, message))
    const approvalCancelled = this.approvals.cancelConversation(id)
    const agent = this.bindings.get(id)?.agent ?? this.ctx.agents.get(SessionId(id))
    if (agent === undefined || agent.status === 'idle') return approvalCancelled
    agent.cancel({ kind: 'user' })
    return true
  }

  /** Resolve a pending approval from the same Weixin conversation. */
  decideApproval(message: WeixinMessage, command: ApprovalCommand): ResolvedApproval | undefined {
    return this.approvals.decide(this.activeIdFor(sessionIdFor(this.accountId, message)), command)
  }

  /** Close pending approval answerers before the bridge waits for in-flight messages. */
  cancelPendingApprovals(): void {
    this.approvals.cancelAll()
  }

  /** Dispose every bridge-owned Agent after queued work settles. */
  async dispose(): Promise<void> {
    this.approvals.cancelAll()
    await Promise.allSettled(this.rotations.values())
    await Promise.allSettled(this.queues.values())
    await Promise.allSettled([...this.bindings.values()].map(binding => binding.release()))
    this.bindings.clear()
  }

  private async processNow(
    id: string,
    message: WeixinMessage,
    api: WeixinApiPort,
    sendApprovalPrompt?: (text: string) => Promise<void>,
  ): Promise<ConversationReply> {
    const binding = await this.getOrCreate(id)
    const agent = binding.agent
    const content = await inboundContent(
      this.ctx,
      this.config,
      api,
      message,
      await this.includeImages(agent),
      agent.session.header?.cwd ?? this.config.cwd,
    )
    await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness conversation availability')
    const start = agent.session.events.length
    const userMessage = createUserMessage({ content, source: { kind: 'user' } })
    const sendPrompt = sendApprovalPrompt ?? ((text: string) => {
      const to = message.from_user_id?.trim()
      if (!to) return Promise.reject(new Error('Weixin approval has no target user'))
      return api.sendText(to, text, message.context_token)
    })
    const stopApprovalAnswerer = agent.ctx.on(
      'approval/request',
      request => this.approvals.request(id, request, sendPrompt),
      { prepend: true },
    )
    try {
      agent.followup(userMessage)
      try {
        await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness response')
      } catch (error) {
        agent.cancel({ kind: 'user' })
        throw error
      }
      return this.collectReply(agent, agent.session.events.slice(start), userMessage.id)
    } finally {
      stopApprovalAnswerer()
    }
  }

  private async executeCommandNow(
    id: string,
    message: WeixinMessage,
    line: string,
    api: WeixinApiPort,
    sendApprovalPrompt?: (text: string) => Promise<void>,
  ): Promise<ConversationCommandOutcome> {
    const binding = await this.getOrCreate(id)
    const agent = binding.agent
    await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness command availability')
    const parsed = parseCommand(line)
    if (parsed === undefined) {
      return { kind: 'unknown', available: this.ctx.commands.list(agent).map(command => `/${command.name}`) }
    }
    const start = agent.session.events.length
    const sendPrompt = sendApprovalPrompt ?? ((text: string) => {
      const to = message.from_user_id?.trim()
      if (!to) return Promise.reject(new Error('Weixin approval has no target user'))
      return api.sendText(to, text, message.context_token)
    })
    const stopApprovalAnswerer = agent.ctx.on(
      'approval/request',
      request => this.approvals.request(id, request, sendPrompt),
      { prepend: true },
    )
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error(`DeepSeek Harness command timed out after ${this.config.responseTimeoutMs}ms`))
    }, this.config.responseTimeoutMs)
    try {
      const execution = await this.ctx.commands.execute(agent, line, controller.signal)
      if (execution === undefined) {
        return { kind: 'unknown', available: this.ctx.commands.list(agent).map(command => `/${command.name}`) }
      }
      clearTimeout(timer)
      try {
        await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness command response')
      } catch (error) {
        agent.cancel({ kind: 'user' })
        throw error
      }
      const generated = await this.collectLatestReply(agent, agent.session.events.slice(start))
      const resultText = execution.result.kind === 'error'
        ? `命令执行失败：${execution.result.text}`
        : execution.result.text?.trim() || `命令 /${parsed.name} 已执行。`
      return {
        kind: 'handled',
        reply: generated === undefined
          ? { text: resultText, images: [], files: [] }
          : {
              text: [resultText, generated.text].filter(Boolean).join('\n\n'),
              images: generated.images,
              files: generated.files,
            },
      }
    } finally {
      clearTimeout(timer)
      stopApprovalAnswerer()
    }
  }

  private async rotateConversation(baseId: string): Promise<void> {
    const currentId = this.activeIdFor(baseId)
    this.approvals.cancelConversation(currentId)
    const agent = this.bindings.get(currentId)?.agent ?? this.ctx.agents.get(SessionId(currentId))
    if (agent !== undefined && agent.status !== 'idle') agent.cancel({ kind: 'user' })
    const queued = this.queues.get(currentId)
    if (queued !== undefined) await queued
    if (agent !== undefined) {
      await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness session reset')
    }

    const binding = this.bindings.get(currentId)
    if (binding !== undefined) {
      this.bindings.delete(currentId)
      await binding.release()
    }

    const nextId = this.nextSessionId(baseId)
    this.activeIds.set(baseId, nextId)
    try {
      await this.getOrCreate(nextId)
    } catch (error) {
      this.activeIds.set(baseId, currentId)
      throw error
    }
  }

  private activeIdFor(baseId: string): string {
    const cached = this.activeIds.get(baseId)
    if (cached !== undefined) return cached
    let active = baseId
    let generation = 0
    for (const id of this.persistedIds) {
      const candidate = this.sessionGeneration(baseId, id)
      if (candidate === undefined || candidate <= generation) continue
      generation = candidate
      active = id
    }
    this.activeIds.set(baseId, active)
    return active
  }

  private nextSessionId(baseId: string): string {
    let generation = this.sessionGeneration(baseId, this.activeIdFor(baseId)) ?? 0
    for (const id of this.persistedIds) {
      generation = Math.max(generation, this.sessionGeneration(baseId, id) ?? 0)
    }
    return `${baseId}-new-${generation + 1}`
  }

  private sessionGeneration(baseId: string, id: string): number | undefined {
    if (id === baseId) return 0
    const prefix = `${baseId}-new-`
    if (!id.startsWith(prefix)) return undefined
    const generation = Number(id.slice(prefix.length))
    return Number.isSafeInteger(generation) && generation > 0 ? generation : undefined
  }

  private async includeImages(agent: Agent): Promise<boolean> {
    if (this.config.imageInputMode === 'always') return true
    if (this.config.imageInputMode === 'never') return false
    const { provider, model } = agent.options
    if (provider === undefined || model === undefined) return false
    const info = await this.ctx.llm.resolveModelInfo(provider, model)
    return info.inputModalities?.includes('image') ?? false
  }

  private async getOrCreate(id: string): Promise<ConversationAgentBinding> {
    const sessionId = SessionId(id)
    const existing = this.bindings.get(id)
    if (existing !== undefined && this.ctx.agents.get(sessionId) === existing.agent) return existing
    if (existing !== undefined) {
      this.bindings.delete(id)
      await existing.release()
    }
    const pending = this.creations.get(id)
    if (pending !== undefined) return pending
    const creation = this.createOrResume(id).finally(() => this.creations.delete(id))
    this.creations.set(id, creation)
    const binding = await creation
    this.bindings.set(id, binding)
    return binding
  }

  private async createOrResume(id: string): Promise<ConversationAgentBinding> {
    const sessionId = SessionId(id)
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return this.borrowAgent(live)

    const current = this.ctx.agentDefaultModel.currentSelection()
    const agentOptions = { provider: current.provider, model: current.model }
    if (this.persistedIds.has(id)) {
      const inspected = await this.ctx.sessionPersistence.inspect(sessionId)
      const agentPreset = resolveSessionPreset({
        header: inspected.meta,
        events: inspected.events,
      }) ?? this.resolveAgentPreset()
      try {
        return this.ownAgent(await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions,
          setup: agentCtx => this.setupAgent(agentCtx, agentPreset),
        }))
      } catch (error) {
        const raced = this.ctx.agents.get(sessionId)
        if (raced !== undefined) return this.borrowAgent(raced)
        throw error
      }
    }

    const agentPreset = this.resolveAgentPreset()
    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: this.config.cwd, agentPreset },
        agentOptions,
        setup: agentCtx => this.setupAgent(agentCtx, agentPreset, this.config.permissionPreset),
      })
    } catch (error) {
      const raced = this.ctx.agents.get(sessionId)
      if (raced !== undefined) return this.borrowAgent(raced)
      throw error
    }
    this.persistedIds.add(id)
    handle.agent.inject(createUserMessage({
      content: [{ type: 'text', text: this.config.systemPrompt }],
      source: { kind: 'plugin', plugin: 'deepseek-harness-weixin', form: 'instructions' },
    }))
    return this.ownAgent(handle)
  }

  private ownAgent(handle: AgentHandle): ConversationAgentBinding {
    return { agent: handle.agent, release: () => handle.dispose() }
  }

  private borrowAgent(agent: Agent): ConversationAgentBinding {
    return { agent, release: () => Promise.resolve() }
  }

  private resolveAgentPreset(): string {
    return this.config.agentPreset ?? this.ctx.agentPresets.defaultId
  }

  private async setupAgent(agentCtx: Context, agentPreset: string, permissionPreset?: string): Promise<void> {
    await this.ctx.agentPresets.mount(agentCtx, agentPreset)
    if (permissionPreset !== undefined) {
      const agent = agentCtx.agent
      if (agent === undefined) throw new Error('weixin-channel: Agent setup context has no Agent')
      this.ctx.permissionPresets.set(agent.session, permissionPreset)
    }
  }

  private async collectReply(
    agent: Agent,
    events: readonly SessionEvent[],
    userMessageId: string,
  ): Promise<ConversationReply> {
    const texts: string[] = []
    const images: ConversationReply['images'] = []
    const userIndex = events.findIndex(event => event.type === 'user/message' && event.data.id === userMessageId)
    let turn: number | undefined
    for (let index = userIndex; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'turn/start') continue
      turn = event.data.turn
      break
    }
    const finalTurn = turn === undefined
      ? undefined
      : [...events].reverse().find(event => event.type === 'turn/end' && event.data.turn === turn)
    const finalMessage = turn === undefined
      ? undefined
      : [...events].reverse().find(event => event.type === 'assistant/message'
          && event.data.turn === turn)
    if (finalMessage?.type === 'assistant/message'
        && !finalMessage.data.message.content.some(block => block.type === 'tool-call')) {
      for (const block of finalMessage.data.message.content) {
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
    if (texts.length === 0 && finalTurn?.type === 'turn/end' && finalTurn.data.reason.kind === 'error') {
      return { text: `处理失败（${finalTurn.data.reason.error.code}），请稍后重试。`, images, files: [] }
    }
    if (texts.length === 0 && images.length === 0) {
      return { text: '处理完成，但没有生成可发送的内容。', images, files: [] }
    }
    const text = texts.join('\n\n')
    const collected = await collectOutboundFiles(
      text,
      agent.session.header?.cwd ?? this.config.cwd,
      this.config.maxReplyFiles,
      this.config.maxOutboundFileBytes,
    )
    return {
      text: [text, ...collected.warnings.map(warning => `⚠️ ${warning}`)].filter(Boolean).join('\n\n'),
      images,
      files: collected.files,
    }
  }

  private async collectLatestReply(
    agent: Agent,
    events: readonly SessionEvent[],
  ): Promise<ConversationReply | undefined> {
    const finalTurn = [...events].reverse().find(event => event.type === 'turn/end')
    if (finalTurn?.type !== 'turn/end') return undefined
    const finalMessage = [...events].reverse().find(event => event.type === 'assistant/message'
      && event.data.turn === finalTurn.data.turn)
    const texts: string[] = []
    const images: ConversationReply['images'] = []
    if (finalMessage?.type === 'assistant/message'
        && !finalMessage.data.message.content.some(block => block.type === 'tool-call')) {
      for (const block of finalMessage.data.message.content) {
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
    if (texts.length === 0 && images.length === 0 && finalTurn.data.reason.kind === 'error') {
      return { text: `处理失败（${finalTurn.data.reason.error.code}），请稍后重试。`, images, files: [] }
    }
    if (texts.length === 0 && images.length === 0) return undefined
    const text = texts.join('\n\n')
    const collected = await collectOutboundFiles(
      text,
      agent.session.header?.cwd ?? this.config.cwd,
      this.config.maxReplyFiles,
      this.config.maxOutboundFileBytes,
    )
    return {
      text: [text, ...collected.warnings.map(warning => `⚠️ ${warning}`)].filter(Boolean).join('\n\n'),
      images,
      files: collected.files,
    }
  }
}
