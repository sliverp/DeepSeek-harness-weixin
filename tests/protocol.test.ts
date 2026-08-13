import { createCipheriv } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { WeixinApiClient } from '../src/protocol.js'
import { testConfig } from './fixtures.js'

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('WeixinApiClient', () => {
  it('sends authenticated long-poll requests with the official iLink headers', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ret: 0, msgs: [], get_updates_buf: 'next' }))
    const client = new WeixinApiClient('https://ilink.example', 'test-token', testConfig(), fetchMock as never)
    const result = await client.getUpdates('cursor', 1_000)

    expect(result.get_updates_buf).toBe('next')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://ilink.example/ilink/bot/getupdates')
    expect(init.headers).toMatchObject({
      AuthorizationType: 'ilink_bot_token',
      Authorization: 'Bearer test-token',
      'iLink-App-Id': 'bot',
    })
    expect(JSON.parse(String(init.body))).toMatchObject({ get_updates_buf: 'cursor' })
  })

  it('uploads an AES-encrypted image and sends the returned CDN reference', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push([url, init])
      if (url.endsWith('/getuploadurl')) return jsonResponse({ upload_full_url: 'https://cdn.example/upload' })
      if (url === 'https://cdn.example/upload') {
        return new Response('', { status: 200, headers: { 'x-encrypted-param': 'download-param' } })
      }
      return jsonResponse({ ret: 0 })
    })
    const client = new WeixinApiClient('https://ilink.example', 'test-token', testConfig(), fetchMock as never)
    await client.sendImage('user-1', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'context-1')

    expect(calls).toHaveLength(3)
    const encryptedBody = calls[1]?.[1]?.body
    expect(encryptedBody).toBeInstanceOf(Uint8Array)
    expect((encryptedBody as Uint8Array).byteLength).toBe(16)
    const sent = JSON.parse(String(calls[2]?.[1]?.body))
    expect(sent.msg).toMatchObject({ to_user_id: 'user-1', context_token: 'context-1' })
    expect(sent.msg.item_list[0]).toMatchObject({
      type: 2,
      image_item: { media: { encrypt_query_param: 'download-param', encrypt_type: 1 } },
    })
  })

  it('downloads and decrypts an AES-128-ECB image', async () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const plaintext = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const cipher = createCipheriv('aes-128-ecb', key, null)
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const fetchMock = vi.fn(async () => new Response(encrypted, { status: 200 }))
    const client = new WeixinApiClient('https://ilink.example', 'test-token', testConfig(), fetchMock as never)
    const result = await client.downloadImage({
      media: { full_url: 'https://cdn.example/download' },
      aeskey: key.toString('hex'),
    }, 1_000)
    expect(result).toEqual(plaintext)
  })

  it('surfaces nonzero iLink response codes without exposing credentials', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ret: -2, errmsg: '' }))
    const client = new WeixinApiClient('https://ilink.example', 'test-token', testConfig(), fetchMock as never)
    await expect(client.sendText('user-1', 'hello', 'context-1')).rejects.toThrow('iLink code -2')
  })

  it('rejects an oversized image before requesting an upload URL', async () => {
    const fetchMock = vi.fn()
    const client = new WeixinApiClient(
      'https://ilink.example',
      'test-token',
      testConfig({ maxOutboundImageBytes: 4 }),
      fetchMock as never,
    )
    await expect(client.sendImage('user-1', Buffer.alloc(5), 'context-1')).rejects.toThrow('exceeds')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
