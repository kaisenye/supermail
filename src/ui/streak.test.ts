import { describe, expect, it } from 'vitest'
import { dayKey, isInboxZero, nextStreak } from './streak.js'

describe('inbox-zero streak', () => {
  it('formats local days', () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
  it('counts consecutive days and restarts after a gap', () => {
    expect(nextStreak({ days: 0, lastDay: null }, '2026-10-29')).toEqual({ days: 1, lastDay: '2026-10-29' })
    expect(nextStreak({ days: 1, lastDay: '2026-10-29' }, '2026-10-29')).toEqual({ days: 1, lastDay: '2026-10-29' })
    expect(nextStreak({ days: 4, lastDay: '2026-10-31' }, '2026-11-01')).toEqual({ days: 5, lastDay: '2026-11-01' })
    expect(nextStreak({ days: 4, lastDay: '2026-10-28' }, '2026-10-30')).toEqual({ days: 1, lastDay: '2026-10-30' })
  })
})

describe('isInboxZero', () => {
  const zero = { plainInbox: true, total: 0, hasSyncedOnce: true, syncError: null }
  it('is true for a synced, empty plain Inbox', () => {
    expect(isInboxZero(zero)).toBe(true)
  })
  it('is false before the first sync, on a sync error, or with mail on another page', () => {
    expect(isInboxZero({ ...zero, hasSyncedOnce: false })).toBe(false)
    expect(isInboxZero({ ...zero, syncError: 'offline' })).toBe(false)
    expect(isInboxZero({ ...zero, total: 3 })).toBe(false)
  })
  it('is false for a split, a chip or another folder', () => {
    expect(isInboxZero({ ...zero, plainInbox: false })).toBe(false)
  })
})
