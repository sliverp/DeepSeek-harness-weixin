/** Official Weixin iLink channel bundle for DeepSeek Harness. */

import type { Context } from '@deepseek-ai/cordis'
import { WeixinHarnessBridge, type WeixinLoginRequest } from './bridge.js'
import { Config, type Config as WeixinConfig } from './config.js'
import { resolveControlSocketPath, WeixinControlServer } from './control.js'

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
export type { WeixinLoginRequest }
export type { ConversationCommandOutcome, ConversationReply } from './conversations.js'
export { detectImageMediaType, inboundContent, safeFileName } from './inbound.js'
export { loginWithQr } from './login.js'
export { filterMarkdownForWeixin, StreamingMarkdownFilter } from './markdown-filter.js'
export { collectOutboundFiles } from './outbound-files.js'
export type { OutboundFile, OutboundFileCollection } from './outbound-files.js'
export { WeixinApiClient } from './protocol.js'
export {
  defaultControlSocketPath,
  requestLoginFromControlSocket,
  resolveControlSocketPath,
  waitForLoginFromControlSocket,
  WeixinControlServer,
} from './control.js'
export type { WeixinControlRequestOptions, WeixinControlResponse } from './control.js'
export { loginStandalone } from './standalone-login.js'
export type { StandaloneLoginOptions, StandaloneQrLogin } from './standalone-login.js'
export { parseCredential } from './types.js'
export { SeenMessageIds, sessionIdFor, truncateUtf8 } from './util.js'

interface WeixinBridgeLifecycle {
  startInBackground(): void
  requestLogin(signal?: AbortSignal, displayQr?: boolean): Promise<WeixinLoginRequest>
  stop(): Promise<void>
}

interface WeixinControlLifecycle {
  startInBackground(): void
  stop(): Promise<void>
}

/** Mount a bridge without making the Harness profile wait for QR authorization. */
export function mountBridge(
  ctx: Context,
  bridge: WeixinBridgeLifecycle,
  control?: WeixinControlLifecycle,
): void {
  ctx.effect(() => {
    const unregisterLogin = ctx.commands.register({
      name: 'weixin-login',
      description: 'Show a fresh Weixin QR login code in the Harness terminal',
      recordInput: false,
      handler: async invocation => {
        if (invocation.rawInput.trim() !== '') {
          return { kind: 'error', text: '用法：/weixin-login（不需要参数）' }
        }
        try {
          const result = await bridge.requestLogin(invocation.signal)
          return loginCommandResult(result)
        } catch (error) {
          return {
            kind: 'error',
            text: `无法启动微信扫码：${renderError(error)}。Web 服务不受影响，可稍后再次运行 /weixin-login。`,
          }
        }
      },
    })
    bridge.startInBackground()
    control?.startInBackground()
    return async () => {
      unregisterLogin()
      await control?.stop()
      await bridge.stop()
    }
  }, 'deepseek-harness-weixin.lifecycle')
}

/** Mount the Weixin QR/login channel and tie teardown to the Cordis lifecycle. */
export function apply(ctx: Context, config: WeixinConfig): void {
  const bridge = new WeixinHarnessBridge(ctx, config)
  const control = new WeixinControlServer(
    resolveControlSocketPath(config.controlSocketPath),
    (signal, displayQr) => bridge.requestLogin(signal, displayQr),
    ctx.logger('deepseek-harness-weixin'),
  )
  mountBridge(ctx, bridge, control)
}

export default { name, inject, Config, apply }

function loginCommandResult(result: WeixinLoginRequest) {
  return {
    kind: 'success' as const,
    text: result.reused
      ? '当前扫码流程仍在进行，最新二维码已重新输出到运行 pnpm dsh web 的终端。'
      : '新的微信二维码已输出到运行 pnpm dsh web 的终端，请使用微信扫描并确认连接。',
  }
}

function renderError(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '<无法显示的错误>'
  }
}
