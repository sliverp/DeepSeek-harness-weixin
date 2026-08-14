import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, {
  Session,
  SessionId,
  SessionPreparation,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, vi } from 'vitest'
import { ConversationManager } from '../src/conversations.js'
import { MessageItemType } from '../src/types.js'
import { sessionIdFor } from '../src/util.js'
import { testConfig } from './fixtures.js'

const DSML_TOOL_CALLS = '<｜｜DSML｜｜tool_calls>'
const DSML_INVOKE = '<｜｜DSML｜｜invoke'

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(): StreamChunk[] {
  const callId = CallId('call-list-files')
  const args = JSON.stringify({ path: '.' })
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '我先查看目录。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '我先查看目录。' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: callId, name: 'list_files', argumentsDelta: args },
    {
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: callId, name: 'list_files', arguments: args },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function approvalToolCallResponse(): StreamChunk[] {
  const callId = CallId('call-approved-bash')
  const args = JSON.stringify({ command: 'ls -la' })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: 'bash', argumentsDelta: args },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name: 'bash', arguments: args },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly responses: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('ScriptedAdapter: response script exhausted')
    for (const chunk of response) yield chunk
  }
}

async function toolHarness(adapter: ScriptedAdapter, persistence: object) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)

  let executions = 0
  const mount = vi.fn(async (agentCtx: Context, agentPreset: string) => {
    expect(agentPreset).toBe('standard')
    agentCtx.tools.register(defineContentToolFixture({
      name: 'list_files',
      description: 'List files for the integration test.',
      parameters: { path: { type: 'string', required: true } },
      async execute(args) {
        executions += 1
        expect(args.path).toBe('.')
        return [{ type: 'text', text: 'README.md' }]
      },
    }))
    agentCtx.tools.register(defineContentToolFixture({
      name: 'bash',
      description: 'Run a test command after Harness approval.',
      parameters: { command: { type: 'string', required: true } },
      async execute(args) {
        executions += 1
        expect(args.command).toBe('ls -la')
        return [{ type: 'text', text: 'README.md' }]
      },
    }))
    agentCtx.on('tools/pre-execute', (exec, next) => {
      if (exec.name !== 'bash') return next()
      return Promise.resolve({ kind: 'ask', reason: 'Run the requested directory listing.' } as const)
    })
  })
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'mock', model: 'mock' }),
  } as never)
  ctx.provide('agentPresets', { defaultId: 'standard', mount } as never)
  ctx.provide('sessionPersistence', persistence as never)
  ctx.provide('attachments', {
    imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
  } as never)
  ctx.commands.register({
    name: 'probe',
    description: 'Exercise the Harness command runtime.',
    handler: ({ rawInput }) => ({ kind: 'success', text: `probe:${rawInput}` }),
  })
  return { ctx, mount, executionCount: () => executions }
}

describe('ConversationManager real Agent Loop', () => {
  it('executes registered slash commands through Harness without a model request', async () => {
    const adapter = new ScriptedAdapter([])
    const { ctx } = await toolHarness(adapter, { list: () => Promise.resolve([]) })
    const message = {
      from_user_id: 'command-user',
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: '/probe exact' } }],
    }
    const manager = new ConversationManager(ctx, testConfig(), 'account-1')
    try {
      await manager.initialize()
      await expect(manager.executeCommand(message, '/probe exact', { downloadImage: vi.fn() } as never))
        .resolves.toEqual({
          kind: 'handled',
          reply: { text: 'probe: exact', images: [] },
        })

      const agent = ctx.agents.get(SessionId(sessionIdFor('account-1', message)))
      if (agent === undefined) throw new Error('expected a live command integration-test Agent')
      const commandEvents = agent.session.events.filter(event =>
        event.type === 'command/run' || event.type === 'command/done')
      expect(commandEvents.map(event => event.type)).toEqual(['command/run', 'command/done'])
      expect(commandEvents[0]).toMatchObject({
        type: 'command/run',
        data: { name: 'probe', args: ' exact', source: { kind: 'user' } },
      })
      expect(commandEvents[1]).toMatchObject({
        type: 'command/done',
        data: { kind: 'success', text: 'probe: exact' },
      })
      expect(adapter.requests).toHaveLength(0)

      await expect(manager.executeCommand(message, '/missing', { downloadImage: vi.fn() } as never))
        .resolves.toEqual({ kind: 'unknown', available: ['/probe'] })
      expect(agent.session.events.filter(event =>
        event.type === 'command/run' || event.type === 'command/done')).toHaveLength(2)
      expect(adapter.requests).toHaveLength(0)
    } finally {
      await manager.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('rotates /new to a fresh session, preserves the old log, and resumes the latest generation', async () => {
    const adapter = new ScriptedAdapter([
      textResponse('旧会话回复'),
      textResponse('新会话回复'),
      textResponse('重启后继续新会话'),
    ])
    let stored: { meta: SessionHeader; events: SessionEvent[] } | undefined
    const persistence = {
      list: async () => stored === undefined ? [] : [structuredClone(stored.meta)],
      inspect: async () => {
        if (stored === undefined) throw new Error('rotated session has not been stored')
        return structuredClone(stored)
      },
      prepare: async (id: SessionId) => {
        if (stored === undefined) throw new Error('rotated session has not been stored')
        return SessionPreparation.create(Session.fromRestore(
          id,
          structuredClone(stored.events),
          structuredClone(stored.meta),
        ))
      },
    }
    const { ctx } = await toolHarness(adapter, persistence)
    const message = {
      from_user_id: 'new-session-user',
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'hello' } }],
    }
    const baseId = SessionId(sessionIdFor('account-1', message))
    const rotatedId = SessionId(`${baseId}-new-1`)
    const first = new ConversationManager(ctx, testConfig(), 'account-1')
    let resumed: ConversationManager | undefined
    try {
      await first.initialize()
      await expect(first.process(message, { downloadImage: vi.fn() } as never))
        .resolves.toEqual({ text: '旧会话回复', images: [] })
      const oldAgent = ctx.agents.get(baseId)
      if (oldAgent === undefined) throw new Error('expected the original Agent before /new')
      const oldEvents = structuredClone([...oldAgent.session.events])

      await expect(first.startNewConversation(message)).resolves.toBeUndefined()
      expect(ctx.agents.get(baseId)).toBeUndefined()
      expect(oldAgent.session.events).toEqual(oldEvents)
      expect(ctx.agents.get(rotatedId)).toBeDefined()
      expect(adapter.requests).toHaveLength(1)

      await expect(first.process(message, { downloadImage: vi.fn() } as never))
        .resolves.toEqual({ text: '新会话回复', images: [] })
      const rotated = ctx.agents.get(rotatedId)
      if (rotated === undefined) throw new Error('expected the rotated Agent')
      expect(rotated.session.header.agentPreset).toBe('standard')
      stored = {
        meta: structuredClone(rotated.session.header),
        events: structuredClone([...rotated.session.events]),
      }
      await first.dispose()
      expect(ctx.agents.get(rotatedId)).toBeUndefined()

      resumed = new ConversationManager(ctx, testConfig(), 'account-1')
      await resumed.initialize()
      await expect(resumed.process(message, { downloadImage: vi.fn() } as never))
        .resolves.toEqual({ text: '重启后继续新会话', images: [] })
      expect(ctx.agents.get(rotatedId)).toBeDefined()
      expect(ctx.agents.get(baseId)).toBeUndefined()
      expect(adapter.requests).toHaveLength(3)
    } finally {
      await resumed?.dispose()
      await first.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('mounts tools, executes a structured call, records it, and returns only the final reply', async () => {
    const adapter = new ScriptedAdapter([
      toolCallResponse(),
      textResponse('当前文件：README.md'),
    ])
    const { ctx, executionCount } = await toolHarness(adapter, { list: () => Promise.resolve([]) })

    const message = {
      from_user_id: 'tool-user',
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: '我当前有啥文件？' } }],
    }
    const manager = new ConversationManager(ctx, testConfig(), 'account-1')
    try {
      await manager.initialize()
      const reply = await manager.process(message, { downloadImage: vi.fn() } as never)
      const id = SessionId(sessionIdFor('account-1', message))
      const agent = ctx.agents.get(id)
      if (agent === undefined) throw new Error('expected a live integration-test Agent')
      const events = agent.session.events

      expect(reply).toEqual({ text: '当前文件：README.md', images: [] })
      expect(executionCount()).toBe(1)
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('list_files')
      expect(agent.session.header.agentPreset).toBe('standard')
      expect(events.some(event => event.type === 'tool/call'
        && event.data.name === 'list_files')).toBe(true)
      expect(events.some(event => event.type === 'tool/result'
        && event.data.message.source.callId === CallId('call-list-files'))).toBe(true)
      expect(events.some(event => event.type === 'turn/end'
        && event.data.reason.kind === 'completed')).toBe(true)

      const persistedAssistantText = events
        .filter(event => event.type === 'assistant/message')
        .flatMap(event => event.data.message.content)
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      for (const text of [reply.text, persistedAssistantText]) {
        expect(text).not.toContain(DSML_TOOL_CALLS)
        expect(text).not.toContain(DSML_INVOKE)
      }
      expect(reply.text).not.toContain('我先查看目录。')
    } finally {
      await manager.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('restores the recorded preset and executes tools again after a persistent resume', async () => {
    const adapter = new ScriptedAdapter([
      toolCallResponse(),
      textResponse('首次工具回复'),
      toolCallResponse(),
      textResponse('恢复后工具回复'),
    ])
    let stored: { meta: SessionHeader; events: SessionEvent[] } | undefined
    const inspect = vi.fn(async () => {
      if (stored === undefined) throw new Error('session has not been persisted')
      return structuredClone(stored)
    })
    const persistence = {
      list: async () => stored === undefined ? [] : [structuredClone(stored.meta)],
      inspect,
      prepare: async (id: SessionId) => {
        if (stored === undefined) throw new Error('session has not been persisted')
        const snapshot = structuredClone(stored)
        return SessionPreparation.create(Session.fromRestore(id, snapshot.events, snapshot.meta))
      },
    }
    const { ctx, mount, executionCount } = await toolHarness(adapter, persistence)
    const message = {
      from_user_id: 'resume-tool-user',
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: '我当前有啥文件？' } }],
    }
    const id = SessionId(sessionIdFor('account-1', message))
    const first = new ConversationManager(ctx, testConfig(), 'account-1')
    let resumed: ConversationManager | undefined
    try {
      await first.initialize()
      await expect(first.process(message, { downloadImage: vi.fn() } as never))
        .resolves.toEqual({ text: '首次工具回复', images: [] })
      const original = ctx.agents.get(id)
      if (original === undefined) throw new Error('expected the original live Agent')
      stored = {
        meta: structuredClone(original.session.header),
        events: structuredClone([...original.session.events]),
      }
      await first.dispose()
      expect(ctx.agents.get(id)).toBeUndefined()

      resumed = new ConversationManager(ctx, testConfig({ agentPreset: 'code' }), 'account-1')
      await resumed.initialize()
      await expect(resumed.process(message, { downloadImage: vi.fn() } as never))
        .resolves.toEqual({ text: '恢复后工具回复', images: [] })

      const restored = ctx.agents.get(id)
      if (restored === undefined) throw new Error('expected the resumed live Agent')
      expect(inspect).toHaveBeenCalledWith(id)
      expect(restored.session.header.agentPreset).toBe('standard')
      expect(mount.mock.calls.map(call => call[1])).toEqual(['standard', 'standard'])
      expect(executionCount()).toBe(2)
      expect(restored.session.events.filter(event => event.type === 'tool/call')).toHaveLength(2)
      expect(restored.session.events.filter(event => event.type === 'tool/result')).toHaveLength(2)
      expect(adapter.requests).toHaveLength(4)
    } finally {
      await resumed?.dispose()
      await first.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('waits for a Weixin text approval before the real Agent Loop executes the tool', async () => {
    const adapter = new ScriptedAdapter([
      approvalToolCallResponse(),
      textResponse('审批后文件：README.md'),
    ])
    const { ctx, executionCount } = await toolHarness(adapter, { list: () => Promise.resolve([]) })
    const message = {
      from_user_id: 'approval-tool-user',
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: '我当前有啥文件？' } }],
    }
    const manager = new ConversationManager(ctx, testConfig(), 'account-1')
    const prompts: string[] = []
    try {
      await manager.initialize()
      const work = manager.process(
        message,
        { downloadImage: vi.fn() } as never,
        async text => { prompts.push(text) },
      )
      await vi.waitFor(() => expect(prompts).toHaveLength(1))
      expect(prompts[0]).toContain('Bash 请求执行：ls -la')
      expect(prompts[0]).not.toContain(DSML_TOOL_CALLS)
      expect(prompts[0]).not.toContain(DSML_INVOKE)
      expect(executionCount()).toBe(0)
      const code = /\/approve ([0-9]{6})/.exec(prompts[0] as string)?.[1]
      if (code === undefined) throw new Error('approval code was not rendered')

      expect(manager.decideApproval(message, { code, outcome: 'allowed-once' })).toEqual({
        code,
        outcome: 'allowed-once',
        toolName: 'bash',
      })
      await expect(work).resolves.toEqual({ text: '审批后文件：README.md', images: [] })

      const agent = ctx.agents.get(SessionId(sessionIdFor('account-1', message)))
      if (agent === undefined) throw new Error('expected a live approval integration-test Agent')
      expect(executionCount()).toBe(1)
      expect(agent.session.events.some(event => event.type === 'approval/asked')).toBe(true)
      expect(agent.session.events.some(event => event.type === 'approval/decided'
        && event.data.outcome === 'allowed-once')).toBe(true)
      expect(agent.session.events.some(event => event.type === 'tool/call'
        && event.data.callId === CallId('call-approved-bash')
        && event.data.name === 'bash')).toBe(true)
      expect(agent.session.events.some(event => event.type === 'tool/result'
        && event.data.message.source.callId === CallId('call-approved-bash'))).toBe(true)
      expect(agent.session.events.some(event => event.type === 'turn/end'
        && event.data.reason.kind === 'completed')).toBe(true)
    } finally {
      await manager.dispose()
      await ctx.fiber.dispose()
    }
  })
})
