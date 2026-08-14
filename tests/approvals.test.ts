import { CallId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import {
  formatApprovalPrompt,
  parseApprovalCommand,
  WeixinApprovalRegistry,
} from '../src/approvals.js'

function request(options: { command?: string; reason?: string; signal?: AbortSignal } = {}) {
  const callId = CallId('call-approval')
  const events = options.command === undefined
    ? []
    : [{
        type: 'tool/call',
        data: {
          turn: 1,
          step: 1,
          callId,
          name: 'bash',
          arguments: JSON.stringify({ command: options.command }),
        },
      }]
  return {
    agent: { session: { events } },
    toolName: 'bash',
    callId,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  } as never
}

describe('Weixin approval commands', () => {
  it('parses exact approve/reject commands and intercepts malformed variants', () => {
    expect(parseApprovalCommand('/approve 123456')).toEqual({ code: '123456', outcome: 'allowed-once' })
    expect(parseApprovalCommand('/REJECT 654321')).toEqual({ code: '654321', outcome: 'rejected' })
    expect(parseApprovalCommand('/approve')).toBe('invalid')
    expect(parseApprovalCommand('/reject abc')).toBe('invalid')
    expect(parseApprovalCommand('ordinary message')).toBeUndefined()
  })

  it('renders the command from the structured tool/call linked by call id', () => {
    const prompt = formatApprovalPrompt(request({ command: 'ls -la' }), '123456', 240_000)
    expect(prompt).toBe([
      'Bash 请求执行：ls -la',
      '回复 /approve 123456 或 /reject 123456',
      '该审批将在 240 秒后失效。',
    ].join('\n'))
  })

  it('accepts one decision only from the originating conversation', async () => {
    const registry = new WeixinApprovalRegistry(1_000)
    const prompts: string[] = []
    const pending = registry.request(
      'conversation-a',
      request({ command: 'ls -la' }),
      async text => { prompts.push(text) },
    )
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    const code = /\/approve ([0-9]{6})/.exec(prompts[0] as string)?.[1]
    if (code === undefined) throw new Error('approval code was not rendered')

    expect(registry.decide('conversation-b', { code, outcome: 'allowed-once' })).toBeUndefined()
    expect(registry.decide('conversation-a', { code, outcome: 'allowed-once' })).toEqual({
      code,
      outcome: 'allowed-once',
      toolName: 'bash',
    })
    await expect(pending).resolves.toBe('allowed-once')
    expect(registry.decide('conversation-a', { code, outcome: 'rejected' })).toBeUndefined()

    const rejected = registry.request('conversation-a', request(), async text => { prompts.push(text) })
    await vi.waitFor(() => expect(prompts).toHaveLength(2))
    const rejectCode = /\/reject ([0-9]{6})/.exec(prompts[1] as string)?.[1]
    if (rejectCode === undefined) throw new Error('rejection code was not rendered')
    expect(registry.decide('conversation-a', { code: rejectCode, outcome: 'rejected' })).toEqual({
      code: rejectCode,
      outcome: 'rejected',
      toolName: 'bash',
    })
    await expect(rejected).resolves.toBe('rejected')
  })

  it('fails closed on timeout, transport failure, and cancellation', async () => {
    vi.useFakeTimers()
    try {
      const timed = new WeixinApprovalRegistry(10).request('timed', request(), async () => undefined)
      await vi.advanceTimersByTimeAsync(10)
      await expect(timed).resolves.toBe('unavailable')

      const failed = new WeixinApprovalRegistry(100).request('failed', request(), async () => {
        throw new Error('send failed')
      })
      await expect(failed).resolves.toBe('unavailable')

      const controller = new AbortController()
      const cancelled = new WeixinApprovalRegistry(100).request(
        'cancelled',
        request({ signal: controller.signal }),
        async () => undefined,
      )
      controller.abort()
      await expect(cancelled).resolves.toBe('cancelled')
    } finally {
      vi.useRealTimers()
    }
  })
})
