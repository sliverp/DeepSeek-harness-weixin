import type { Config } from '../src/config.js'

/** Complete deterministic plugin config for unit tests. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    credentialRef: 'WEIXIN_ILINK_CREDENTIAL',
    cwd: '/tmp/weixin-test',
    statePath: '/tmp/weixin-test-sync.json',
    controlSocketPath: '/tmp/weixin-test-control.sock',
    autoLogin: false,
    accessPolicy: 'open',
    allowFrom: [],
    imageInputMode: 'auto',
    maxInboundFiles: 10,
    maxInboundFileBytes: 30 * 1024 * 1024,
    maxInboundMessageFileBytes: 100 * 1024 * 1024,
    responseTimeoutMs: 1_000,
    approvalTimeoutMs: 500,
    mediaDownloadTimeoutMs: 1_000,
    apiTimeoutMs: 1_000,
    longPollTimeoutMs: 1_000,
    loginTimeoutMs: 1_000,
    retryDelayMs: 100,
    backoffDelayMs: 100,
    staleTokenPauseMs: 1_000,
    maxConsecutiveFailures: 2,
    maxInFlightMessages: 2,
    sendRetries: 0,
    maxReplyBytes: 20_000,
    maxReplyImages: 4,
    maxOutboundImageBytes: 10 * 1024 * 1024,
    maxReplyFiles: 5,
    maxOutboundFileBytes: 30 * 1024 * 1024,
    maxSeenMessageIds: 100,
    systemPrompt: 'Weixin test instructions',
    ...overrides,
  }
}

/** Minimal Session stand-in exposing the 0.2.x event-read surface. */
export function fakeSession(
  events: unknown[] = [],
  header: Record<string, unknown> = {},
): {
  events: unknown[]
  header: Record<string, unknown>
  readonly seq: number
  snapshotEvents(fromSeq?: number): readonly unknown[]
} {
  return {
    events,
    header: { version: 0, id: 'session-id', createdAt: 1, cwd: '/tmp/weixin-test', ...header },
    get seq() {
      return events.length
    },
    snapshotEvents(fromSeq = 0) {
      return events.slice(fromSeq)
    },
  }
}

/** Minimal read-only SessionHandle stand-in returned by a persistence `open` mock. */
export function fakeSessionHandle(
  id: string,
  events: unknown[] = [],
  header: Record<string, unknown> = {},
): {
  readonly id?: string
  readonly header: Record<string, unknown>
  read(): Promise<{ events: readonly unknown[] }>
  close(): Promise<void>
} {
  return {
    header: { version: 0, id, createdAt: 1, cwd: '/tmp/weixin-test', ...header },
    async read() {
      return { events }
    },
    async close() {},
  }
}
