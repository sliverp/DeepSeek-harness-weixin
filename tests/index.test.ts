import { describe, expect, it, vi } from 'vitest'
import { mountBridge } from '../src/index.js'

const CREDENTIAL = {
  token: 'test-token',
  accountId: 'account@im.bot',
  baseUrl: 'https://ilink.example',
}

describe('Weixin plugin lifecycle', () => {
  it('does not block Harness startup and registers an active QR command', async () => {
    let dispose: (() => Promise<void>) | undefined
    let loginHandler: ((invocation: {
      rawInput: string
      signal: AbortSignal
    }) => Promise<{ kind: string; text?: string }>) | undefined
    const unregister = vi.fn()
    const ctx = {
      commands: {
        register: vi.fn((definition: { name: string; handler: typeof loginHandler }) => {
          expect(definition.name).toBe('weixin-login')
          loginHandler = definition.handler
          return unregister
        }),
      },
      effect: vi.fn((setup: () => () => Promise<void>) => {
        dispose = setup()
      }),
    }
    const bridge = {
      startInBackground: vi.fn(),
      requestLogin: vi.fn(async () => ({
        kind: 'qr-shown' as const,
        reused: false,
        url: 'https://qr.example/secret',
        completion: Promise.resolve(CREDENTIAL),
      })),
      stop: vi.fn(async () => undefined),
    }
    const control = {
      startInBackground: vi.fn(),
      stop: vi.fn(async () => undefined),
    }

    expect(mountBridge(ctx as never, bridge, control)).toBeUndefined()
    expect(bridge.startInBackground).toHaveBeenCalledOnce()
    expect(control.startInBackground).toHaveBeenCalledOnce()
    expect(loginHandler).toBeDefined()

    const result = await loginHandler?.({ rawInput: '', signal: new AbortController().signal })
    expect(result).toEqual({
      kind: 'success',
      text: '新的微信二维码已输出到运行 pnpm dsh web 的终端，请使用微信扫描并确认连接。',
    })
    expect(result?.text).not.toContain('https://')

    await dispose?.()
    expect(unregister).toHaveBeenCalledOnce()
    expect(control.stop).toHaveBeenCalledOnce()
    expect(bridge.stop).toHaveBeenCalledOnce()
  })

  it('reports command failures without leaking them into Web startup', async () => {
    let loginHandler: ((invocation: {
      rawInput: string
      signal: AbortSignal
    }) => Promise<{ kind: string; text?: string }>) | undefined
    const ctx = {
      commands: {
        register: vi.fn((definition: { handler: typeof loginHandler }) => {
          loginHandler = definition.handler
          return vi.fn()
        }),
      },
      effect: vi.fn((setup: () => () => Promise<void>) => { setup() }),
    }
    const bridge = {
      startInBackground: vi.fn(),
      requestLogin: vi.fn(async () => { throw new Error('QR endpoint unavailable') }),
      stop: vi.fn(async () => undefined),
    }

    mountBridge(ctx as never, bridge)
    const result = await loginHandler?.({ rawInput: '', signal: new AbortController().signal })
    expect(result).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('Web 服务不受影响'),
    })
  })
})
