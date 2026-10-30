import { describe, expect, it } from 'vitest'
import { addressedToMe, classifyEligible, FRESH_MS, isNotificationSender, repliesEligible, type Candidate } from './eligibility.js'

const NOW = 10_000_000_000
const base: Candidate = {
  id: 1,
  account_id: 1,
  message_id: '<a@t>',
  thread_id: 't',
  from_addr: 'ann@x.test',
  me: 'me@x.test',
  role: 'inbox',
  bulk: 0,
  list_unsubscribe: null,
  to_addrs: JSON.stringify([{ address: 'Me@X.test', name: null }]),
  cc_addrs: '[]',
  date: NOW - 1000,
  last_from_me: 0
}

describe('who gets background AI', () => {
  it('classifies fresh, non-bulk Inbox mail from someone else', () => {
    expect(classifyEligible(base, NOW)).toBe(true)
    expect(classifyEligible({ ...base, role: 'sent' }, NOW)).toBe(false)
    expect(classifyEligible({ ...base, from_addr: 'ME@x.test' }, NOW)).toBe(false)
    expect(classifyEligible({ ...base, bulk: 1 }, NOW)).toBe(false)
    expect(classifyEligible({ ...base, list_unsubscribe: '<mailto:u@x>' }, NOW)).toBe(false)
    expect(classifyEligible({ ...base, date: NOW - FRESH_MS - 1 }, NOW)).toBe(false)
    expect(classifyEligible({ ...base, message_id: null }, NOW)).toBe(false)
  })

  it('suggests replies only to people writing to me, not to robots or settled threads', () => {
    expect(repliesEligible(base, NOW, { fresh: true })).toBe(true)
    expect(repliesEligible({ ...base, from_addr: 'no-reply@shop.test' }, NOW, { fresh: true })).toBe(false)
    expect(repliesEligible({ ...base, to_addrs: '[]', cc_addrs: '[]' }, NOW, { fresh: true })).toBe(false)
    expect(repliesEligible({ ...base, last_from_me: 1 }, NOW, { fresh: true })).toBe(false)
    // On demand (the user opened it), age does not matter.
    expect(repliesEligible({ ...base, date: 1 }, NOW, { fresh: false })).toBe(true)
  })

  it('recognises notification senders and my address in Cc', () => {
    for (const a of ['noreply@x.test', 'do-not-reply@x.test', 'notifications@github.com', 'mailer-daemon@x', 'alerts+42@bank.test'])
      expect(isNotificationSender(a)).toBe(true)
    expect(isNotificationSender('nora@x.test')).toBe(false)
    expect(addressedToMe({ ...base, to_addrs: '[]', cc_addrs: JSON.stringify([{ address: 'me@x.test' }]) })).toBe(true)
  })
})
