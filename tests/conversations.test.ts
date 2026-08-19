import { describe, expect, it, vi } from 'vitest'
import { ConversationManager } from '../src/conversations.js'
import { MessageItemType, type WeixinMessage } from '../src/types.js'
import { sessionIdFor } from '../src/util.js'
import { testConfig } from './fixtures.js'

function inbound(sender: string, text: string): WeixinMessage {
  return {
    from_user_id: sender,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  }
}

function appendTextTurn(
  events: unknown[],
  userMessage: { id: string },
  text: string,
  turn = 1,
): void {
  events.push(
    { type: 'turn/start', data: { turn } },
    { type: 'user/message', data: userMessage },
    { type: 'step/start', data: { turn, step: 1 } },
    {
      type: 'assistant/message',
      data: { turn, step: 1, message: { content: [{ type: 'text', text }] } },
    },
    { type: 'step/end', data: { turn, step: 1 } },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  )
}

function attachmentService(): object {
  return {
    imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 100, maxImageBytes: 100 },
    readImage: vi.fn(),
    saveImage: vi.fn(),
  }
}

function approvalScope(): object {
  return { on: vi.fn(() => vi.fn()) }
}

describe('ConversationManager', () => {
  it('records and mounts the configured preset when creating a persistent Agent', async () => {
    const events: unknown[] = []
    const agent = {
      status: 'idle',
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { events },
      ctx: approvalScope(),
      inject: vi.fn(),
      followup: vi.fn((userMessage: { id: string }) => appendTextTurn(events, userMessage, 'hello weixin')),
      whenIdle: vi.fn(async () => undefined),
    }
    const dispose = vi.fn(async () => undefined)
    const mount = vi.fn(async () => ({ id: 'standard' }))
    const create = vi.fn(async (options: { setup?: (ctx: never) => Promise<void> }) => {
      await options.setup?.({ agent } as never)
      return { agent, dispose }
    })
    const setPermission = vi.fn()
    const resolvePermission = vi.fn(() => ({ sandbox: 'danger-full-access', approval: 'never' }))
    const ctx = {
      sessionPersistence: { list: vi.fn(async () => []) },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
      agentPresets: { defaultId: 'standard', mount },
      permissionPresets: { resolve: resolvePermission, set: setPermission },
      agents: { create, resume: vi.fn(), get: vi.fn() },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      attachments: attachmentService(),
    } as never
    const manager = new ConversationManager(
      ctx,
      testConfig({ permissionPreset: 'danger-full-access' }),
      'account-1',
    )
    await manager.initialize()

    await expect(manager.process(inbound('user-1', 'hi'), { downloadImage: vi.fn() } as never))
      .resolves.toEqual({ text: 'hello weixin', images: [], files: [] })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      meta: { cwd: '/tmp/weixin-test', agentPreset: 'standard' },
      setup: expect.any(Function),
    }))
    expect(mount).toHaveBeenCalledWith(expect.anything(), 'standard')
    expect(resolvePermission).toHaveBeenCalledWith('danger-full-access')
    expect(setPermission).toHaveBeenCalledWith(agent.session, 'danger-full-access')
    expect(agent.inject).toHaveBeenCalledOnce()
    expect(agent.followup).toHaveBeenCalledOnce()
    expect(agent.whenIdle).toHaveBeenCalledTimes(2)
    await manager.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('restores the latest preset recorded in a persistent session before resuming it', async () => {
    const message = inbound('user-resume', 'continue')
    const id = sessionIdFor('account-1', message)
    const events: unknown[] = []
    const agent = {
      status: 'idle',
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { events },
      ctx: approvalScope(),
      inject: vi.fn(),
      followup: vi.fn((userMessage: { id: string }) => appendTextTurn(events, userMessage, 'resumed reply')),
      whenIdle: vi.fn(async () => undefined),
    }
    const dispose = vi.fn(async () => undefined)
    const mount = vi.fn(async () => ({ id: 'minimal' }))
    const resume = vi.fn(async (options: { setup?: (ctx: never) => Promise<void> }) => {
      await options.setup?.({} as never)
      return { agent, dispose }
    })
    const inspect = vi.fn(async () => ({
      meta: { version: 0, id, createdAt: 1, cwd: '/tmp/weixin-test', agentPreset: 'standard' },
      events: [{
        type: 'agent-preset/selected',
        seq: 0,
        time: 1,
        data: { agentPreset: 'minimal' },
      }],
    }))
    const ctx = {
      sessionPersistence: { list: vi.fn(async () => [{ id }]), inspect },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
      agentPresets: { defaultId: 'standard', mount },
      agents: { create: vi.fn(), resume, get: vi.fn() },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      attachments: attachmentService(),
    } as never
    const manager = new ConversationManager(ctx, testConfig(), 'account-1')
    await manager.initialize()

    await expect(manager.process(message, { downloadImage: vi.fn() } as never))
      .resolves.toEqual({ text: 'resumed reply', images: [], files: [] })

    expect(inspect).toHaveBeenCalledWith(id)
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ setup: expect.any(Function) }))
    expect(mount).toHaveBeenCalledWith(expect.anything(), 'minimal')
    expect(agent.inject).not.toHaveBeenCalled()
    await manager.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('uses the current configured preset as the explicit fallback for an unrecorded legacy session', async () => {
    const message = inbound('user-legacy', 'continue')
    const id = sessionIdFor('account-1', message)
    const events: unknown[] = []
    const agent = {
      status: 'idle',
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { events },
      ctx: approvalScope(),
      followup: vi.fn((userMessage: { id: string }) => appendTextTurn(events, userMessage, 'fallback reply')),
      whenIdle: vi.fn(async () => undefined),
    }
    const mount = vi.fn(async () => ({ id: 'code' }))
    const resume = vi.fn(async (options: { setup?: (ctx: never) => Promise<void> }) => {
      await options.setup?.({} as never)
      return { agent, dispose: vi.fn(async () => undefined) }
    })
    const ctx = {
      sessionPersistence: {
        list: vi.fn(async () => [{ id }]),
        inspect: vi.fn(async () => ({
          meta: { version: 0, id, createdAt: 1, cwd: '/tmp/weixin-test' },
          events: [],
        })),
      },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
      agentPresets: { defaultId: 'standard', mount },
      agents: { create: vi.fn(), resume, get: vi.fn() },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      attachments: attachmentService(),
    } as never
    const manager = new ConversationManager(ctx, testConfig({ agentPreset: 'code' }), 'account-1')
    await manager.initialize()

    await expect(manager.process(message, { downloadImage: vi.fn() } as never))
      .resolves.toEqual({ text: 'fallback reply', images: [], files: [] })
    expect(mount).toHaveBeenCalledWith(expect.anything(), 'code')
    await manager.dispose()
  })

  it('borrows an existing live Agent, waits for it, and returns only this message turn', async () => {
    const message = inbound('user-live', 'weixin follow-up')
    const id = sessionIdFor('account-1', message)
    const events: unknown[] = []
    let submitted: { id: string } | undefined
    let idleCalls = 0
    const agent = {
      status: 'idle',
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { events },
      ctx: approvalScope(),
      followup: vi.fn((userMessage: { id: string }) => { submitted = userMessage }),
      whenIdle: vi.fn(async () => {
        idleCalls += 1
        if (idleCalls === 1) {
          appendTextTurn(events, { id: 'earlier-web-message' }, 'earlier Web reply', 7)
          return
        }
        if (submitted === undefined) throw new Error('followup was not submitted')
        appendTextTurn(events, submitted, 'weixin reply', 8)
        appendTextTurn(events, { id: 'later-web-message' }, 'later Web reply', 9)
      }),
    }
    const inspect = vi.fn()
    const resume = vi.fn()
    const create = vi.fn()
    const mount = vi.fn()
    const ctx = {
      sessionPersistence: { list: vi.fn(async () => [{ id }]), inspect },
      agentDefaultModel: { currentSelection: vi.fn() },
      agentPresets: { defaultId: 'standard', mount },
      agents: { get: vi.fn(() => agent), resume, create },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      attachments: attachmentService(),
    } as never
    const manager = new ConversationManager(ctx, testConfig(), 'account-1')
    await manager.initialize()

    await expect(manager.process(message, { downloadImage: vi.fn() } as never))
      .resolves.toEqual({ text: 'weixin reply', images: [], files: [] })

    expect(agent.whenIdle).toHaveBeenCalledTimes(2)
    expect(inspect).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(mount).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it('routes an interactive approval to the originating Weixin conversation', async () => {
    const events: unknown[] = []
    let answerApproval: ((request: object) => Promise<string>) | undefined
    const stopApprovalAnswerer = vi.fn()
    const on = vi.fn((event: string, handler: (request: object) => Promise<string>, options: object) => {
      expect(event).toBe('approval/request')
      expect(options).toEqual({ prepend: true })
      answerApproval = handler
      return stopApprovalAnswerer
    })
    let idleCalls = 0
    let submitted: { id: string } | undefined
    const agent = {
      status: 'idle',
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { events },
      ctx: { on },
      followup: vi.fn((message: { id: string }) => { submitted = message }),
      whenIdle: vi.fn(async () => {
        idleCalls += 1
        if (idleCalls !== 2) return
        if (answerApproval === undefined || submitted === undefined) throw new Error('turn was not prepared')
        expect(await answerApproval({ agent, toolName: 'bash', reason: '列出当前目录' })).toBe('allowed-once')
        appendTextTurn(events, submitted, '审批后执行完成。')
      }),
    }
    const ctx = {
      sessionPersistence: { list: vi.fn(async () => []) },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
      agentPresets: { defaultId: 'standard', mount: vi.fn() },
      agents: { get: vi.fn(() => agent), create: vi.fn(), resume: vi.fn() },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      attachments: attachmentService(),
    } as never
    const manager = new ConversationManager(ctx, testConfig(), 'account-1')
    await manager.initialize()

    const message = inbound('approval-user', '执行需要审批的操作')
    const prompts: string[] = []
    const work = manager.process(
      message,
      { downloadImage: vi.fn() } as never,
      async text => { prompts.push(text) },
    )
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    const code = /\/approve ([0-9]{6})/.exec(prompts[0] as string)?.[1]
    if (code === undefined) throw new Error('approval code was not rendered')
    expect(manager.decideApproval(inbound('another-user', ''), { code, outcome: 'allowed-once' })).toBeUndefined()
    expect(manager.decideApproval(message, { code, outcome: 'allowed-once' })).toEqual({
      code,
      outcome: 'allowed-once',
      toolName: 'bash',
    })

    await expect(work).resolves.toEqual({ text: '审批后执行完成。', images: [], files: [] })
    expect(on).toHaveBeenCalledOnce()
    expect(stopApprovalAnswerer).toHaveBeenCalledOnce()
    await manager.dispose()
  })

  it('cancels a timed-out response without leaving a rejecting queue tracker', async () => {
    let idleCalls = 0
    let settleResponse: (() => void) | undefined
    const cancel = vi.fn(() => settleResponse?.())
    const agent = {
      status: 'idle',
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { events: [] },
      ctx: approvalScope(),
      followup: vi.fn(),
      cancel,
      whenIdle: vi.fn(() => {
        idleCalls += 1
        if (idleCalls === 1) return Promise.resolve()
        return new Promise<void>(resolve => { settleResponse = resolve })
      }),
    }
    const ctx = {
      sessionPersistence: { list: vi.fn(async () => []) },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
      agentPresets: { defaultId: 'standard', mount: vi.fn() },
      agents: { get: vi.fn(() => agent), create: vi.fn(), resume: vi.fn() },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      attachments: attachmentService(),
    } as never
    const manager = new ConversationManager(ctx, testConfig({ responseTimeoutMs: 5 }), 'account-1')
    await manager.initialize()

    await expect(manager.process(inbound('timeout-user', 'hang'), { downloadImage: vi.fn() } as never))
      .rejects.toThrow('DeepSeek Harness response timed out after 5ms')
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' })
    await expect(manager.dispose()).resolves.toBeUndefined()
  })
})
