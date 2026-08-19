/** Common request metadata attached to every iLink request. */
export interface BaseInfo {
  channel_version: string
  bot_agent: string
}

/** Weixin media type codes used by upload and message APIs. */
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const

/** Weixin message item codes. */
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const

/** Sender type codes. */
export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const

/** Generation state codes. */
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const

/** Encrypted Weixin CDN reference. */
export interface CdnMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

/** One image item. */
export interface ImageItem {
  media?: CdnMedia
  thumb_media?: CdnMedia
  aeskey?: string
  url?: string
  mid_size?: number
  thumb_size?: number
  thumb_height?: number
  thumb_width?: number
  hd_size?: number
}

/** One encrypted generic file item. */
export interface FileItem {
  media?: CdnMedia
  file_name?: string
  md5?: string
  len?: string
}

/** One structured message item. */
export interface MessageItem {
  type?: number
  create_time_ms?: number
  update_time_ms?: number
  is_completed?: boolean
  msg_id?: string
  ref_msg?: { message_item?: MessageItem; title?: string }
  text_item?: { text?: string }
  image_item?: ImageItem
  voice_item?: { media?: CdnMedia; text?: string }
  file_item?: FileItem
  video_item?: { media?: CdnMedia; video_size?: number; thumb_media?: CdnMedia }
}

/** Message returned by the iLink getupdates API. */
export interface WeixinMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  update_time_ms?: number
  delete_time_ms?: number
  session_id?: string
  group_id?: string
  message_type?: number
  message_state?: number
  item_list?: MessageItem[]
  context_token?: string
  run_id?: string
}

/** Long-poll result. */
export interface GetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

/** Credential issued after a successful QR confirmation. */
export interface WeixinCredential {
  token: string
  accountId: string
  baseUrl: string
  userId?: string
}

/** Parse and validate the managed JSON credential without exposing its values. */
export function parseCredential(value: string): WeixinCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('weixin-channel: managed credential is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('weixin-channel: managed credential must be a JSON object')
  }
  const data = parsed as Record<string, unknown>
  if (typeof data.token !== 'string' || data.token.trim() === '') {
    throw new Error('weixin-channel: managed credential has no token')
  }
  if (typeof data.accountId !== 'string' || data.accountId.trim() === '') {
    throw new Error('weixin-channel: managed credential has no accountId')
  }
  if (typeof data.baseUrl !== 'string' || !isHttpsUrl(data.baseUrl)) {
    throw new Error('weixin-channel: managed credential baseUrl must be an HTTPS URL')
  }
  return {
    token: data.token.trim(),
    accountId: data.accountId.trim(),
    baseUrl: data.baseUrl.replace(/\/+$/, ''),
    ...(typeof data.userId === 'string' && data.userId.trim() ? { userId: data.userId.trim() } : {}),
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
