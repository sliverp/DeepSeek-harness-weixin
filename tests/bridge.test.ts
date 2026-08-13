import { describe, expect, it, vi } from 'vitest'
import { WeixinHarnessBridge } from '../src/bridge.js'
import type { WeixinApiPort } from '../src/protocol.js'
import { MessageItemType, MessageType, type GetUpdatesResponse, type WeixinCredential } from '../src/types.js'
import { testConfig } from './fixtures.js'

const CREDENTIAL: WeixinCredential = {
  token: 'managed-token',
  accountId: 'account@im.bot',
  baseUrl: 'https://ilink.example',
  userId: 'user-1',
}

class FakeApi implements WeixinApiPort {
  readonly sentTexts: Array<{ to: string; text: string; context?: string }> = []
  readonly sentImages: Array<{ to: string; data: Uint8Array; context?: string }> = []
  readonly notifyStart = vi.fn(async () => undefined)
  readonly notifyStop = vi.fn(async () => undefined)
  readonly downloadImage = vi.fn(async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  private readonly updates: GetUpdatesResponse[]

  constructor(...updates: GetUpdatesResponse[]) {
    this.updates = updates
  }

  async getUpdates(cursor: string, _timeout: number, signal?: AbortSignal): Promise<GetUpdatesResponse> {
    const next = this.updates.shift()
    if (next !== undefined) return next
    if (signal?.aborted) return { ret: 0, msgs: [], get_updates_buf: cursor }
    return new Promise(resolve => signal?.addEventListener(
      'abort',
      () => resolve({ ret: 0, msgs: [], get_updates_buf: cursor }),
      { once: true },
    ))
  }

  async sendText(to: string, text: string, context?: string): Promise<void> {
    this.sentTexts.push({ to, text, ...(context === undefined ? {} : { context }) })
  }

  async sendImage(to: string, data: Uint8Array, context?: string): Promise<void> {
    this.sentImages.push({ to, data, ...(context === undefined ? {} : { context }) })
  }
}

function message(text: string, id = 1) {
  return {
    message_id: id,
    message_type: MessageType.USER,
    from_user_id: 'user-1',
    context_token: 'context-1',
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  }
}

function commandContext(value: string | undefined): never {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return {
    logger: vi.fn(() => logger),
    credentials: {
      resolve: vi.fn(async () => value === undefined ? undefined : { value, source: 'test' }),
      set: vi.fn(async () => undefined),
    },
    sessionPersistence: { list: vi.fn(async () => []) },
  } as never
}

function agentContext(): never {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const events: unknown[] = []
  const ref = { attachmentId: 'sha256:reply', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
  const agent = {
    status: 'idle',
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session: { events },
    inject: vi.fn(),
    followup: vi.fn(() => {
      events.push({ type: 'assistant/message', data: { message: { content: [
        { type: 'text', text: 'model reply' },
        { type: 'image', attachment: ref },
      ] } } })
      events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    }),
    whenIdle: vi.fn(async () => undefined),
  }
  return {
    logger: vi.fn(() => logger),
    credentials: {
      resolve: vi.fn(async () => ({ value: JSON.stringify(CREDENTIAL), source: 'test' })),
      set: vi.fn(async () => undefined),
    },
    sessionPersistence: { list: vi.fn(async () => []) },
    agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
    llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
    agents: { create: vi.fn(async () => ({ agent, dispose: vi.fn(async () => undefined) })), get: vi.fn() },
    attachments: {
      imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000, maxImageBytes: 10_000 },
      readImage: vi.fn(async () => ({ ref, data: new Uint8Array([1, 2, 3]) })),
      saveImage: vi.fn(),
    },
  } as never
}

describe('WeixinHarnessBridge', () => {
  it('verifies the managed credential and replies to a live ping', async () => {
    const api = new FakeApi({ ret: 0, msgs: [message('/bot-ping')] })
    const factory = vi.fn(() => api)
    const bridge = new WeixinHarnessBridge(
      commandContext(JSON.stringify(CREDENTIAL)),
      testConfig(),
      factory,
    )
    await bridge.start()
    await vi.waitFor(() => expect(api.sentTexts).toHaveLength(1))
    expect(factory).toHaveBeenCalledWith(CREDENTIAL, expect.any(Object))
    expect(api.sentTexts[0]).toMatchObject({ to: 'user-1', context: 'context-1', text: expect.stringContaining('pong') })
    await bridge.stop()
    expect(api.notifyStart).toHaveBeenCalledOnce()
    expect(api.notifyStop).toHaveBeenCalledOnce()
  })

  it('performs QR login and stores the issued credential when none exists', async () => {
    const api = new FakeApi()
    const ctx = commandContext(undefined)
    const login = vi.fn(async () => CREDENTIAL)
    const bridge = new WeixinHarnessBridge(ctx, testConfig({ autoLogin: true }), () => api, login as never)
    await bridge.start()
    expect(login).toHaveBeenCalledOnce()
    expect((ctx as { credentials: { set: ReturnType<typeof vi.fn> } }).credentials.set)
      .toHaveBeenCalledWith('WEIXIN_ILINK_CREDENTIAL', JSON.stringify(CREDENTIAL))
    await bridge.stop()
  })

  it('fails before constructing an API client when login is disabled and no credential exists', async () => {
    const factory = vi.fn()
    const bridge = new WeixinHarnessBridge(commandContext(undefined), testConfig(), factory as never)
    await expect(bridge.start()).rejects.toThrow('not configured')
    expect(factory).not.toHaveBeenCalled()
  })

  it('sends the built-in image diagnostic through the image API', async () => {
    const api = new FakeApi({ ret: 0, msgs: [message('/bot-image-test', 2)] })
    const bridge = new WeixinHarnessBridge(commandContext(JSON.stringify(CREDENTIAL)), testConfig(), () => api)
    await bridge.start()
    await vi.waitFor(() => expect(api.sentImages).toHaveLength(1))
    expect(Buffer.from(api.sentImages[0]?.data ?? []).subarray(0, 8))
      .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    await bridge.stop()
  })

  it('runs ordinary text through Harness and sends model text plus image', async () => {
    const api = new FakeApi({ ret: 0, msgs: [message('hello model', 3)] })
    const bridge = new WeixinHarnessBridge(agentContext(), testConfig(), () => api)
    await bridge.start()
    await vi.waitFor(() => expect(api.sentImages).toHaveLength(1))
    expect(api.sentTexts[0]?.text).toBe('model reply')
    await bridge.stop()
  })

  it('drops a sender excluded by the configured allowlist', async () => {
    const api = new FakeApi({ ret: 0, msgs: [message('/bot-ping', 4)] })
    const bridge = new WeixinHarnessBridge(
      commandContext(JSON.stringify(CREDENTIAL)),
      testConfig({ accessPolicy: 'allowlist', allowFrom: ['someone-else'] }),
      () => api,
    )
    await bridge.start()
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(api.sentTexts).toEqual([])
    await bridge.stop()
  })
})
