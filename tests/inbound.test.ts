import { describe, expect, it, vi } from 'vitest'
import { detectImageMediaType, inboundContent } from '../src/inbound.js'
import { MessageItemType, type WeixinMessage } from '../src/types.js'
import { testConfig } from './fixtures.js'

function context(): never {
  return {
    attachments: {
      imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 100, maxImageBytes: 100 },
      saveImage: vi.fn(async ({ data, mediaType }: { data: Buffer; mediaType: string }) => ({
        attachmentId: 'sha256:image', mediaType, bytes: data.byteLength, width: 1, height: 1,
      })),
    },
  } as never
}

function imageMessage(): WeixinMessage {
  return {
    from_user_id: 'user-123456789',
    item_list: [
      { type: MessageItemType.TEXT, text_item: { text: 'caption' } },
      { type: MessageItemType.IMAGE, image_item: { media: { encrypt_query_param: 'encrypted' } } },
    ],
  }
}

describe('inboundContent', () => {
  it('turns mixed text and decrypted image into durable Harness blocks', async () => {
    const api = { downloadImage: vi.fn(async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) }
    const blocks = await inboundContent(context(), testConfig(), api as never, imageMessage())
    expect(blocks[0]).toMatchObject({ type: 'text', text: expect.stringContaining('caption') })
    expect(blocks[1]).toMatchObject({ type: 'image', attachment: { mediaType: 'image/png' } })
    expect(api.downloadImage).toHaveBeenCalledOnce()
  })

  it('stores images but emits metadata for a text-only model', async () => {
    const api = { downloadImage: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0x00])) }
    const blocks = await inboundContent(context(), testConfig(), api as never, imageMessage(), false)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'text', text: expect.stringContaining('text-only') })
  })

  it('rejects a decrypted image over the Harness attachment limit', async () => {
    const api = { downloadImage: vi.fn(async () => Buffer.alloc(101)) }
    await expect(inboundContent(context(), testConfig(), api as never, imageMessage()))
      .rejects.toThrow('attachment limit')
  })

  it('recognizes all accepted image magic values', () => {
    expect(detectImageMediaType(Buffer.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg')
    expect(detectImageMediaType(Buffer.from('GIF89a'))).toBe('image/gif')
    const webp = Buffer.alloc(12)
    webp.write('RIFF', 0)
    webp.write('WEBP', 8)
    expect(detectImageMediaType(webp)).toBe('image/webp')
    expect(() => detectImageMediaType(Buffer.from('not-image'))).toThrow('unrecognized')
  })
})
