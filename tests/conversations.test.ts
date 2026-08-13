import { describe, expect, it, vi } from 'vitest'
import { ConversationManager } from '../src/conversations.js'
import { MessageItemType } from '../src/types.js'
import { testConfig } from './fixtures.js'

describe('ConversationManager', () => {
  it('creates one persistent Harness agent and returns its assistant text', async () => {
    const events: unknown[] = []
    const agent = {
      status: 'idle',
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { events },
      inject: vi.fn(),
      followup: vi.fn(() => {
        events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello weixin' }] } } })
        events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      }),
      whenIdle: vi.fn(async () => undefined),
    }
    const handle = { agent, dispose: vi.fn(async () => undefined) }
    const ctx = {
      sessionPersistence: { list: vi.fn(async () => []) },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
      agents: { create: vi.fn(async () => handle), resume: vi.fn(), get: vi.fn() },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 100, maxImageBytes: 100 },
        readImage: vi.fn(), saveImage: vi.fn(),
      },
    } as never
    const manager = new ConversationManager(ctx, testConfig(), 'account-1')
    await manager.initialize()
    const reply = await manager.process({
      from_user_id: 'user-1',
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'hi' } }],
    }, { downloadImage: vi.fn() } as never)

    expect(reply).toEqual({ text: 'hello weixin', images: [] })
    expect((ctx as { agents: { create: ReturnType<typeof vi.fn> } }).agents.create).toHaveBeenCalledOnce()
    expect(agent.inject).toHaveBeenCalledOnce()
    await manager.dispose()
  })
})
