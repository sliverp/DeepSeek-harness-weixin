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
    commands: {
      execute: vi.fn(async () => undefined),
      list: vi.fn(() => []),
    },
  } as never
}

function agentContext(replyText = 'model reply', includeToolStep = false, stallResponse = false): never {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const events: unknown[] = []
  const ref = { attachmentId: 'sha256:reply', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
  let idleCalls = 0
  let registeredId: string | undefined
  const agent = {
    status: 'idle',
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session: { events },
    ctx: { on: vi.fn(() => vi.fn()) },
    inject: vi.fn(),
    followup: vi.fn((userMessage: { id: string }) => {
      events.push(
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: userMessage },
        { type: 'step/start', data: { turn: 1, step: 1 } },
      )
      if (includeToolStep) {
        events.push(
          { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [
            { type: 'text', text: '正在查看目录。' },
            { type: 'tool-call', id: 'call-1', name: 'Bash', arguments: '{"command":"ls"}' },
          ] } } },
          { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'Bash', arguments: '{"command":"ls"}' } },
          { type: 'tool/result', data: { turn: 1, step: 1, message: { source: { callId: 'call-1' } } } },
          { type: 'step/end', data: { turn: 1, step: 1 } },
          { type: 'step/start', data: { turn: 1, step: 2 } },
        )
      }
      const step = includeToolStep ? 2 : 1
      events.push({ type: 'assistant/message', data: { turn: 1, step, message: { content: [
        { type: 'text', text: replyText },
        { type: 'image', attachment: ref },
      ] } } })
      events.push(
        { type: 'step/end', data: { turn: 1, step } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      )
    }),
    whenIdle: vi.fn(() => {
      idleCalls += 1
      if (stallResponse && idleCalls > 1) return new Promise<void>(() => undefined)
      return Promise.resolve()
    }),
    cancel: vi.fn(),
  }
  return {
    logger: vi.fn(() => logger),
    credentials: {
      resolve: vi.fn(async () => ({ value: JSON.stringify(CREDENTIAL), source: 'test' })),
      set: vi.fn(async () => undefined),
    },
    sessionPersistence: { list: vi.fn(async () => []) },
    commands: {
      execute: vi.fn(async () => undefined),
      list: vi.fn(() => []),
    },
    agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
    agentPresets: { defaultId: 'standard', mount: vi.fn(async () => ({ id: 'standard' })) },
    llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
    agents: {
      create: vi.fn(async (options: { sessionId?: string; setup?: (ctx: never) => Promise<void> }) => {
        await options.setup?.({} as never)
        registeredId = options.sessionId
        return {
          agent,
          dispose: vi.fn(async () => {
            if (registeredId === options.sessionId) registeredId = undefined
          }),
        }
      }),
      get: vi.fn((id: string) => String(id) === registeredId ? agent : undefined),
    },
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

  it('starts QR login in the background without waiting for authorization', async () => {
    const ctx = commandContext(undefined)
    const login = vi.fn((options: { signal?: AbortSignal }) => new Promise<WeixinCredential>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('login stopped')), { once: true })
    }))
    const bridge = new WeixinHarnessBridge(
      ctx,
      testConfig({ autoLogin: true }),
      () => new FakeApi(),
      login as never,
      vi.fn(async () => undefined),
    )

    expect(bridge.startInBackground()).toBeUndefined()
    await vi.waitFor(() => expect(login).toHaveBeenCalledOnce())
    await bridge.stop()
  })

  it('starts a fresh QR attempt on explicit request after background login is unavailable', async () => {
    const api = new FakeApi()
    const ctx = commandContext(undefined)
    const showQr = vi.fn(async () => undefined)
    const login = vi.fn(async (options: {
      callbacks?: { showQr?: (url: string) => Promise<void> }
    }) => {
      await options.callbacks?.showQr?.('https://qr.example/fresh')
      return CREDENTIAL
    })
    const bridge = new WeixinHarnessBridge(
      ctx,
      testConfig({ autoLogin: false }),
      () => api,
      login as never,
      showQr,
    )

    bridge.startInBackground()
    await vi.waitFor(() => {
      expect((ctx as { credentials: { resolve: ReturnType<typeof vi.fn> } }).credentials.resolve).toHaveBeenCalled()
    })
    const result = await bridge.requestLogin()

    expect(result).toEqual({ kind: 'qr-shown', reused: false, url: 'https://qr.example/fresh' })
    expect(showQr).toHaveBeenCalledWith('https://qr.example/fresh')
    expect(login).toHaveBeenCalledOnce()
    await bridge.start()
    expect((ctx as { credentials: { set: ReturnType<typeof vi.fn> } }).credentials.set)
      .toHaveBeenCalledWith('WEIXIN_ILINK_CREDENTIAL', JSON.stringify(CREDENTIAL))
    await bridge.stop()
  })

  it('starts a new QR flow after an earlier background scan attempt expires', async () => {
    const api = new FakeApi()
    const showQr = vi.fn(async () => undefined)
    const login = vi.fn()
      .mockRejectedValueOnce(new Error('微信扫码登录超时，请重新启动后再试'))
      .mockImplementationOnce(async (options: {
        callbacks?: { showQr?: (url: string) => Promise<void> }
      }) => {
        await options.callbacks?.showQr?.('https://qr.example/after-expiry')
        return CREDENTIAL
      })
    const bridge = new WeixinHarnessBridge(
      commandContext(undefined),
      testConfig({ autoLogin: true }),
      () => api,
      login as never,
      showQr,
    )

    bridge.startInBackground()
    await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(1))
    await expect(bridge.requestLogin()).resolves.toEqual({
      kind: 'qr-shown',
      reused: false,
      url: 'https://qr.example/after-expiry',
    })
    expect(login).toHaveBeenCalledTimes(2)
    expect(showQr).toHaveBeenCalledWith('https://qr.example/after-expiry')

    await bridge.start()
    await bridge.stop()
  })

  it('reprints the latest QR instead of starting a second login writer', async () => {
    let finishLogin!: (credential: WeixinCredential) => void
    const login = vi.fn(async (options: {
      callbacks?: { showQr?: (url: string) => Promise<void> }
    }) => {
      await options.callbacks?.showQr?.('https://qr.example/current')
      return new Promise<WeixinCredential>(resolve => { finishLogin = resolve })
    })
    const showQr = vi.fn(async () => undefined)
    const bridge = new WeixinHarnessBridge(
      commandContext(undefined),
      testConfig({ autoLogin: true }),
      () => new FakeApi(),
      login as never,
      showQr,
    )

    bridge.startInBackground()
    await vi.waitFor(() => expect(showQr).toHaveBeenCalledOnce())
    await expect(bridge.requestLogin()).resolves.toEqual({
      kind: 'qr-shown',
      reused: true,
      url: 'https://qr.example/current',
    })
    expect(showQr).toHaveBeenCalledTimes(2)
    expect(login).toHaveBeenCalledOnce()

    finishLogin(CREDENTIAL)
    await bridge.start()
    await bridge.stop()
  })

  it('fails before constructing an API client when login is disabled and no credential exists', async () => {
    const factory = vi.fn()
    const bridge = new WeixinHarnessBridge(commandContext(undefined), testConfig(), factory as never)
    await expect(bridge.start()).rejects.toThrow('not configured')
    expect(factory).not.toHaveBeenCalled()
  })

  it('requires the approval deadline to leave time for the Agent Loop to finish', () => {
    expect(() => new WeixinHarnessBridge(
      commandContext(JSON.stringify(CREDENTIAL)),
      testConfig({ responseTimeoutMs: 1_000, approvalTimeoutMs: 1_000 }),
    )).toThrow('approvalTimeoutMs must be less than responseTimeoutMs')
  })

  it('intercepts malformed and expired approval commands instead of sending them to the model', async () => {
    const api = new FakeApi({
      ret: 0,
      msgs: [
        message('/approve nope', 20),
        message('/approve 123456', 21),
        message('/reject 654321', 22),
      ],
    })
    const bridge = new WeixinHarnessBridge(
      commandContext(JSON.stringify(CREDENTIAL)),
      testConfig(),
      () => api,
    )
    await bridge.start()
    await vi.waitFor(() => expect(api.sentTexts).toHaveLength(3))
    expect(api.sentTexts.map(sent => sent.text)).toEqual(expect.arrayContaining([
      expect.stringContaining('审批命令格式不正确'),
      expect.stringContaining('没有找到待处理的审批 123456'),
      expect.stringContaining('没有找到待处理的审批 654321'),
    ]))
    await bridge.stop()
  })

  it('starts a fresh persistent session for /new without sending the command to the model', async () => {
    const api = new FakeApi({ ret: 0, msgs: [message('/new', 23)] })
    const ctx = agentContext()
    const bridge = new WeixinHarnessBridge(ctx, testConfig(), () => api)
    await bridge.start()
    await vi.waitFor(() => expect(api.sentTexts).toHaveLength(1))
    expect(api.sentTexts[0]?.text).toContain('已开始新的 Harness 会话')

    const create = (ctx as { agents: { create: ReturnType<typeof vi.fn> } }).agents.create
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      sessionId: expect.stringMatching(/-new-1$/),
    })
    const handle = await create.mock.results[0]?.value
    expect(handle.agent.followup).not.toHaveBeenCalled()
    await bridge.stop()
  })

  it('routes registered Harness slash commands directly and keeps unknown commands out of the model', async () => {
    const api = new FakeApi({
      ret: 0,
      msgs: [message('/plan off', 24), message('/missing', 25)],
    })
    const ctx = agentContext()
    const commands = (ctx as {
      commands: {
        execute: ReturnType<typeof vi.fn>
        list: ReturnType<typeof vi.fn>
      }
    }).commands
    commands.execute
      .mockResolvedValueOnce({ commandId: 'cmd-plan', result: { kind: 'success', text: 'Plan mode off.' } })
      .mockResolvedValueOnce(undefined)
    commands.list.mockReturnValue([{ name: 'plan', description: 'Enter or leave plan mode' }])

    const bridge = new WeixinHarnessBridge(ctx, testConfig(), () => api)
    await bridge.start()
    await vi.waitFor(() => expect(api.sentTexts).toHaveLength(2))
    expect(api.sentTexts.map(sent => sent.text)).toEqual(expect.arrayContaining([
      'Plan mode off.',
      expect.stringContaining('未知命令 "/missing"'),
    ]))
    expect(commands.execute).toHaveBeenCalledTimes(2)

    const create = (ctx as { agents: { create: ReturnType<typeof vi.fn> } }).agents.create
    const handle = await create.mock.results[0]?.value
    expect(handle.agent.followup).not.toHaveBeenCalled()
    await bridge.stop()
  })

  it('lets an approval command bypass a generation occupying the in-flight limit', async () => {
    const api = new FakeApi({
      ret: 0,
      msgs: [message('keep working', 30), message('/approve 123456', 31)],
    })
    const bridge = new WeixinHarnessBridge(
      agentContext('late reply', false, true),
      testConfig({
        maxInFlightMessages: 1,
        responseTimeoutMs: 100,
        approvalTimeoutMs: 50,
      }),
      () => api,
    )
    await bridge.start()
    await vi.waitFor(() => expect(api.sentTexts.some(sent =>
      sent.text.includes('没有找到待处理的审批 123456'))).toBe(true))
    await bridge.stop()
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

  it('filters model output to the Tencent-compatible Markdown subset before sending', async () => {
    const api = new FakeApi({ ret: 0, msgs: [message('markdown please', 5)] })
    const reply = [
      '## 标题',
      '**重点**和*中文斜体*![模型图片](https://example.com/image.png)',
    ].join('\n')
    const bridge = new WeixinHarnessBridge(agentContext(reply), testConfig(), () => api)
    await bridge.start()
    await vi.waitFor(() => expect(api.sentTexts).toHaveLength(1))
    expect(api.sentTexts[0]?.text).toBe('## 标题\n**重点**和中文斜体')
    await bridge.stop()
  })

  it('sends only the final visible response after a structured tool step', async () => {
    const api = new FakeApi({ ret: 0, msgs: [message('我当前有啥文件？', 6)] })
    const bridge = new WeixinHarnessBridge(agentContext('当前文件：README.md', true), testConfig(), () => api)
    await bridge.start()
    await vi.waitFor(() => expect(api.sentTexts).toHaveLength(1))

    expect(api.sentTexts[0]?.text).toBe('当前文件：README.md')
    expect(api.sentTexts[0]?.text).not.toContain('正在查看目录。')
    for (const sent of api.sentTexts) {
      expect(sent.text).not.toContain('<｜｜DSML｜｜tool_calls>')
      expect(sent.text).not.toContain('<｜｜DSML｜｜invoke')
    }
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
