import { describe, expect, it } from 'vitest'
import { messageKey, SeenMessageIds, sessionIdFor, truncateUtf8 } from '../src/util.js'

describe('Weixin utilities', () => {
  it('derives stable opaque session ids without exposing the user id', () => {
    const first = sessionIdFor('account', { from_user_id: 'weixin-user-secret' })
    const second = sessionIdFor('account', { from_user_id: 'weixin-user-secret' })
    expect(first).toBe(second)
    expect(first).toMatch(/^weixin-v3-single-[0-9a-f]{32}$/)
    expect(first).not.toContain('weixin-user-secret')
  })

  it('rejects messages without a sender', () => {
    expect(() => sessionIdFor('account', {})).toThrow('sender')
  })

  it('truncates UTF-8 without splitting a code point', () => {
    const result = truncateUtf8('甲乙丙丁', 10, '…')
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(10)
    expect(result).toBe('甲乙…')
  })

  it('evicts the oldest duplicate id at the configured bound', () => {
    const seen = new SeenMessageIds(2)
    expect(seen.hasOrAdd('a')).toBe(false)
    expect(seen.hasOrAdd('a')).toBe(true)
    expect(seen.hasOrAdd('b')).toBe(false)
    expect(seen.hasOrAdd('c')).toBe(false)
    expect(seen.hasOrAdd('a')).toBe(false)
  })

  it('uses protocol ids before falling back to a content digest', () => {
    expect(messageKey({ message_id: 42 })).toBe('42')
    expect(messageKey({ client_id: 'client-1' })).toBe('client-1')
    expect(messageKey({ from_user_id: 'u1' })).toMatch(/^[0-9a-f]{64}$/)
  })
})
