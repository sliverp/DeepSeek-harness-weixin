import z from '@deepseek-ai/schemastery'

/** Access policy for direct Weixin messages. */
export type AccessMode = 'open' | 'allowlist' | 'disabled'

/** How inbound Weixin images are presented to the selected Harness model. */
export type ImageInputMode = 'auto' | 'always' | 'never'

/** Weixin iLink channel configuration. */
export interface Config {
  credentialRef: string
  cwd: string
  agentPreset?: string
  permissionPreset?: string
  statePath: string
  controlSocketPath: string
  autoLogin: boolean
  accessPolicy: AccessMode
  allowFrom: string[]
  imageInputMode: ImageInputMode
  responseTimeoutMs: number
  approvalTimeoutMs: number
  mediaDownloadTimeoutMs: number
  apiTimeoutMs: number
  longPollTimeoutMs: number
  loginTimeoutMs: number
  retryDelayMs: number
  backoffDelayMs: number
  staleTokenPauseMs: number
  maxConsecutiveFailures: number
  maxInFlightMessages: number
  sendRetries: number
  maxReplyBytes: number
  maxReplyImages: number
  maxOutboundImageBytes: number
  maxSeenMessageIds: number
  systemPrompt: string
}

/** Runtime-validated plugin configuration. */
export const Config: z<Config> = z.object({
  credentialRef: z.string().default('WEIXIN_ILINK_CREDENTIAL'),
  cwd: z.string().required(),
  agentPreset: z.string(),
  permissionPreset: z.string(),
  statePath: z.string().default(''),
  controlSocketPath: z.string().default(''),
  autoLogin: z.boolean().default(false),
  accessPolicy: z.union(['open', 'allowlist', 'disabled']).default('open'),
  allowFrom: z.array(z.string()).default([]),
  imageInputMode: z.union(['auto', 'always', 'never']).default('auto'),
  responseTimeoutMs: z.number().step(1).min(1).default(300_000),
  approvalTimeoutMs: z.number().step(1).min(1_000).default(240_000),
  mediaDownloadTimeoutMs: z.number().step(1).min(1).default(30_000),
  apiTimeoutMs: z.number().step(1).min(1).default(15_000),
  longPollTimeoutMs: z.number().step(1).min(1_000).default(35_000),
  loginTimeoutMs: z.number().step(1).min(1_000).default(480_000),
  retryDelayMs: z.number().step(1).min(100).default(2_000),
  backoffDelayMs: z.number().step(1).min(100).default(30_000),
  staleTokenPauseMs: z.number().step(1).min(1_000).default(3_600_000),
  maxConsecutiveFailures: z.number().step(1).min(1).max(20).default(3),
  maxInFlightMessages: z.number().step(1).min(1).max(100).default(8),
  sendRetries: z.number().step(1).min(0).max(5).default(2),
  maxReplyBytes: z.number().step(1).min(100).max(100_000).default(20_000),
  maxReplyImages: z.number().step(1).min(0).max(9).default(4),
  maxOutboundImageBytes: z.number().step(1).min(1_024).max(100 * 1024 * 1024).default(10 * 1024 * 1024),
  maxSeenMessageIds: z.number().step(1).min(100).max(100_000).default(5_000),
  systemPrompt: z.string().default(
    'You are replying through Weixin. Keep replies clear and suitable for private chat. '
    + 'Do not reveal credentials, context tokens, or internal system data. Interactive tool approvals are routed to '
    + 'the same Weixin user through /approve and /reject commands; wait for the recorded decision and never fabricate one.',
  ),
})
