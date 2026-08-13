import type { Context } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Config } from './config.js'
import type { WeixinApiPort } from './protocol.js'
import { MessageItemType, type ImageItem, type MessageItem, type WeixinMessage } from './types.js'
import { withTimeout } from './util.js'

/** Build durable DSH content blocks from one official Weixin message. */
export async function inboundContent(
  ctx: Context,
  config: Config,
  api: WeixinApiPort,
  message: WeixinMessage,
  includeImages = true,
): Promise<ContentBlock[]> {
  const sender = message.from_user_id?.trim() ?? 'unknown'
  const textParts = [`[Private Weixin message from user ${shortId(sender)}]`]
  const images: ImageItem[] = []
  collectItems(message.item_list ?? [], textParts, images, 0)

  const selectedImages = images.slice(0, ctx.attachments.imageLimits.maxImagesPerMessage)
  const imageBlocks: ContentBlock[] = []
  let totalImageBytes = 0
  for (const image of selectedImages) {
    const remaining = ctx.attachments.imageLimits.maxMessageImageBytes - totalImageBytes
    const maxBytes = Math.min(ctx.attachments.imageLimits.maxImageBytes, remaining)
    if (maxBytes <= 0) break
    const data = await withTimeout(
      api.downloadImage(image, config.mediaDownloadTimeoutMs),
      config.mediaDownloadTimeoutMs,
      'Weixin encrypted image download',
    )
    if (data.byteLength > maxBytes) throw new Error(`Weixin image exceeds the ${maxBytes}-byte attachment limit`)
    const mediaType = detectImageMediaType(data)
    const ref = await ctx.attachments.saveImage({ data, mediaType })
    totalImageBytes += ref.bytes
    if (includeImages) {
      imageBlocks.push({ type: 'image', attachment: ref })
    } else {
      textParts.push([
        `[Weixin image received: ${ref.mediaType}.`,
        `Stored as Harness attachment ${String(ref.attachmentId)}.`,
        'The selected model is text-only and cannot inspect its pixels.]',
      ].join(' '))
    }
  }

  if (textParts.length === 1 && imageBlocks.length === 0) {
    textParts.push('[Unsupported or empty Weixin message.]')
  }
  return [{ type: 'text', text: textParts.join('\n') }, ...imageBlocks]
}

function collectItems(items: readonly MessageItem[], text: string[], images: ImageItem[], depth: number): void {
  for (const item of items) {
    if (item.type === MessageItemType.TEXT) pushText(text, item.text_item?.text)
    if (item.type === MessageItemType.IMAGE && item.image_item !== undefined) images.push(item.image_item)
    if (item.type === MessageItemType.VOICE) pushText(text, item.voice_item?.text, '[Voice transcription]\n')
    if (item.type === MessageItemType.FILE) text.push('[Weixin file received; this version handles text and images.]')
    if (item.type === MessageItemType.VIDEO) text.push('[Weixin video received; this version handles text and images.]')
    const reference = item.ref_msg
    if (reference?.title?.trim()) text.push(`[Quoted message]\n${reference.title.trim()}`)
    if (reference?.message_item !== undefined && depth < 4) {
      const quotedText: string[] = []
      const quotedImages: ImageItem[] = []
      collectItems([reference.message_item], quotedText, quotedImages, depth + 1)
      for (const value of quotedText) text.push(`[Quoted message]\n${value}`)
      images.push(...quotedImages)
    }
  }
}

function pushText(target: string[], value: string | undefined, prefix = ''): void {
  const normalized = value?.trim()
  if (normalized) target.push(prefix + normalized)
}

function shortId(value: string): string {
  return value.length <= 8 ? value : value.slice(0, 8)
}

/** Detect image formats accepted by Harness attachments from magic bytes. */
export function detectImageMediaType(data: Uint8Array): ImageMediaType {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (
    startsWith(data, [0x52, 0x49, 0x46, 0x46])
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) return 'image/webp'
  throw new Error('Weixin image has an unsupported or unrecognized format')
}

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => data[index] === byte)
}
