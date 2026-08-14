import { randomInt } from 'node:crypto'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { truncateUtf8 } from './util.js'

/** A decision command intercepted by the Weixin channel. */
export interface ApprovalCommand {
  code: string
  outcome: Extract<ApprovalOutcome, 'allowed-once' | 'rejected'>
}

/** Result returned after resolving one pending approval. */
export interface ResolvedApproval {
  code: string
  outcome: ApprovalCommand['outcome']
  toolName: string
}

interface PendingApproval {
  code: string
  conversationId: string
  toolName: string
  finish(outcome: ApprovalOutcome): boolean
}

/** Parse an approval command; `invalid` prevents malformed commands from reaching the model. */
export function parseApprovalCommand(text: string): ApprovalCommand | 'invalid' | undefined {
  const trimmed = text.trim()
  if (!/^\/(?:approve|reject)(?:\s|$)/i.test(trimmed)) return undefined
  const match = /^\/(approve|reject)\s+([0-9]{6})$/i.exec(trimmed)
  if (match === null) return 'invalid'
  return {
    code: match[2] as string,
    outcome: match[1]?.toLowerCase() === 'approve' ? 'allowed-once' : 'rejected',
  }
}

/** Owns the short-lived mapping between Harness approval requests and Weixin reply commands. */
export class WeixinApprovalRegistry {
  private readonly pending = new Map<string, PendingApproval>()

  constructor(private readonly timeoutMs: number) {}

  /** Ask one Weixin user and await a one-shot Harness approval outcome. */
  async request(
    conversationId: string,
    request: ApprovalRequest,
    sendPrompt: (text: string) => Promise<void>,
  ): Promise<ApprovalOutcome> {
    if (request.signal?.aborted) return 'cancelled'
    const code = this.createCode(conversationId)
    const key = approvalKey(conversationId, code)
    const decision = Promise.withResolvers<ApprovalOutcome>()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => { pending.finish('cancelled') }
    const pending: PendingApproval = {
      code,
      conversationId,
      toolName: request.toolName,
      finish: (outcome) => {
        if (settled) return false
        settled = true
        this.pending.delete(key)
        if (timer !== undefined) clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        decision.resolve(outcome)
        return true
      },
    }
    this.pending.set(key, pending)
    timer = setTimeout(() => pending.finish('unavailable'), this.timeoutMs)
    request.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      await sendPrompt(formatApprovalPrompt(request, code, this.timeoutMs))
    } catch {
      pending.finish('unavailable')
    }
    return decision.promise
  }

  /** Resolve a pending request only when the command came from its originating conversation. */
  decide(
    conversationId: string,
    command: ApprovalCommand,
  ): ResolvedApproval | undefined {
    const pending = this.pending.get(approvalKey(conversationId, command.code))
    if (pending === undefined || !pending.finish(command.outcome)) return undefined
    return {
      code: pending.code,
      outcome: command.outcome,
      toolName: pending.toolName,
    }
  }

  /** Cancel every pending request for one conversation. */
  cancelConversation(conversationId: string): boolean {
    let cancelled = false
    for (const pending of [...this.pending.values()]) {
      if (pending.conversationId !== conversationId) continue
      cancelled = pending.finish('cancelled') || cancelled
    }
    return cancelled
  }

  /** Cancel every pending request during channel teardown. */
  cancelAll(): void {
    for (const pending of [...this.pending.values()]) pending.finish('cancelled')
  }

  private createCode(conversationId: string): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = String(randomInt(100_000, 1_000_000))
      if (!this.pending.has(approvalKey(conversationId, code))) return code
    }
    throw new Error('weixin-channel: could not allocate a unique approval code')
  }
}

/** Render the exact structured tool call linked by the approval request when available. */
export function formatApprovalPrompt(request: ApprovalRequest, code: string, timeoutMs: number): string {
  const toolName = request.toolName.toLowerCase() === 'bash' ? 'Bash' : request.toolName
  const detail = approvalDetail(request)
  return [
    `${toolName} 请求执行：${detail}`,
    `回复 /approve ${code} 或 /reject ${code}`,
    `该审批将在 ${Math.ceil(timeoutMs / 1_000)} 秒后失效。`,
  ].join('\n')
}

function approvalDetail(request: ApprovalRequest): string {
  const call = request.callId === undefined
    ? undefined
    : [...request.agent.session.events].reverse().find(event => event.type === 'tool/call'
        && event.data.callId === request.callId)
  if (call?.type === 'tool/call') {
    try {
      const parsed: unknown = JSON.parse(call.data.arguments)
      if (isRecord(parsed) && typeof parsed.command === 'string' && parsed.command.trim()) {
        return truncateUtf8(parsed.command, 2_000, '\n[命令已截断]')
      }
    } catch {
      // The durable tool call remains authoritative; malformed JSON falls back to its reason or raw arguments.
    }
    if (call.data.arguments.trim()) return truncateUtf8(call.data.arguments, 2_000, '\n[参数已截断]')
  }
  return truncateUtf8(request.reason?.trim() || '未提供操作说明。', 2_000, '\n[说明已截断]')
}

function approvalKey(conversationId: string, code: string): string {
  return `${conversationId}\0${code}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
