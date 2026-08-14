/** Official Weixin iLink channel bundle for DeepSeek Harness. */

import type { Context } from '@deepseek-ai/cordis'
import { WeixinHarnessBridge } from './bridge.js'
import { Config, type Config as WeixinConfig } from './config.js'

export const name = 'deepseek-harness-weixin'
export const inject = [
  'agentDefaultModel',
  'agentPresets',
  'agents',
  'approval',
  'attachments',
  'commands',
  'credentials',
  'llm',
  'permissionPresets',
  'sessionPersistence',
]
export { Config }
export type { WeixinConfig as ConfigType }
export { formatApprovalPrompt, parseApprovalCommand, WeixinApprovalRegistry } from './approvals.js'
export type { ApprovalCommand, ResolvedApproval } from './approvals.js'
export { WeixinHarnessBridge }
export type { ConversationCommandOutcome, ConversationReply } from './conversations.js'
export { detectImageMediaType, inboundContent } from './inbound.js'
export { loginWithQr } from './login.js'
export { filterMarkdownForWeixin, StreamingMarkdownFilter } from './markdown-filter.js'
export { WeixinApiClient } from './protocol.js'
export { parseCredential } from './types.js'
export { SeenMessageIds, sessionIdFor, truncateUtf8 } from './util.js'

/** Mount the Weixin QR/login channel and tie teardown to the Cordis lifecycle. */
export async function apply(ctx: Context, config: WeixinConfig): Promise<void> {
  const bridge = new WeixinHarnessBridge(ctx, config)
  await ctx.effect(async function* () {
    yield async () => bridge.stop()
    await bridge.start()
  }, 'deepseek-harness-weixin.long-poll')
}

export default { name, inject, Config, apply }
