import { describe, expect, it, vi } from 'vitest'
import { loginWithQr } from '../src/login.js'

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 })
}

describe('loginWithQr', () => {
  it('returns the token, account and routed base URL after QR confirmation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ qrcode: 'qr-id', qrcode_img_content: 'https://qr.example/one' }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'confirmed',
        bot_token: 'issued-token',
        ilink_bot_id: 'account@im.bot',
        ilink_user_id: 'user-1',
        baseurl: 'https://routed.example/',
      }))
    const showQr = vi.fn(async () => undefined)
    const result = await loginWithQr({
      timeoutMs: 1_000,
      callbacks: { showQr, status: vi.fn() },
      fetchImpl: fetchMock,
    })

    expect(showQr).toHaveBeenCalledWith('https://qr.example/one')
    expect(result).toEqual({
      token: 'issued-token',
      accountId: 'account@im.bot',
      userId: 'user-1',
      baseUrl: 'https://routed.example',
    })
  })

  it('submits the phone verification code when the server requests it', async () => {
    const urls: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      urls.push(url)
      if (urls.length === 1) return jsonResponse({ qrcode: 'qr-id', qrcode_img_content: 'https://qr.example/one' })
      if (urls.length === 2) return jsonResponse({ status: 'need_verifycode' })
      return jsonResponse({ status: 'confirmed', bot_token: 'token', ilink_bot_id: 'account' })
    })
    const readVerifyCode = vi.fn(async () => '123456')
    await loginWithQr({
      timeoutMs: 1_000,
      callbacks: { showQr: vi.fn(async () => undefined), readVerifyCode, status: vi.fn() },
      fetchImpl: fetchMock,
    })
    expect(readVerifyCode).toHaveBeenCalledOnce()
    expect(urls[2]).toContain('verify_code=123456')
  })

  it('rejects an incomplete QR response', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ qrcode: 'missing-url' }))
    await expect(loginWithQr({ timeoutMs: 1_000, fetchImpl: fetchMock })).rejects.toThrow('有效二维码')
  })

  it('cancels a pending QR request during plugin teardown', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    }))
    const login = loginWithQr({ timeoutMs: 30_000, fetchImpl: fetchMock, signal: controller.signal })

    controller.abort(new Error('plugin stopped'))
    await expect(login).rejects.toThrow()
  })
})
