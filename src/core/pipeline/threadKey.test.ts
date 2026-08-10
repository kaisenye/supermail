import { describe, expect, it } from 'vitest'
import { threadKey, validId } from './threadKey.js'

/**
 * These cover the threading bugs that shipped: a literal `<>` becoming the
 * thread id for unrelated mail, and replies each starting their own thread
 * because References never reached the key.
 */
describe('validId', () => {
  it('rejects the empty message-id Zimbra emits', () => {
    expect(validId('<>')).toBeNull()
  })

  it('rejects blanks and stray brackets', () => {
    expect(validId('')).toBeNull()
    expect(validId('   ')).toBeNull()
    expect(validId('<')).toBeNull()
    expect(validId(null)).toBeNull()
    expect(validId(undefined)).toBeNull()
  })

  it('keeps a real id, trimmed', () => {
    expect(validId('  <a@b.com>  ')).toBe('<a@b.com>')
  })
})

describe('threadKey', () => {
  it('uses the first VALID reference, not references[0]', () => {
    // Poltra's Zimbra prefixes the header with <>; taking [0] blindly made
    // that the thread id for every message passing through it.
    expect(threadKey(['<>', '<root@x>', '<mid@x>'], null, '<own@x>')).toBe('<root@x>')
  })

  it('falls back to in-reply-to when there are no references', () => {
    // The envelope-only sync path has no References at all (RFC 3501), so a
    // reply must still land on its parent rather than on itself.
    expect(threadKey(null, '<parent@x>', '<own@x>')).toBe('<parent@x>')
  })

  it('falls back to its own id for a genuinely new thread', () => {
    expect(threadKey(null, null, '<own@x>')).toBe('<own@x>')
  })

  it('skips an invalid in-reply-to rather than threading on <>', () => {
    expect(threadKey(null, '<>', '<own@x>')).toBe('<own@x>')
  })

  it('returns null when nothing usable is present', () => {
    expect(threadKey(['<>'], '<>', null)).toBeNull()
  })

  it('agrees across replies in one conversation', () => {
    // Every reply carries the root somewhere in its chain, so all of them
    // must resolve to the same key regardless of arrival order.
    const a = threadKey(['<>', '<root@x>'], '<root@x>', '<r1@x>')
    const b = threadKey(['<>', '<root@x>', '<r1@x>'], '<r1@x>', '<r2@x>')
    expect(a).toBe('<root@x>')
    expect(b).toBe('<root@x>')
  })
})
