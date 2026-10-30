import { describe, expect, it } from 'vitest'
import type { MessageListRow } from './types.js'
import { mergeByDate } from './searchAll.js'

const row = (id: number, date: number, account_id = 1) => ({ id, date, account_id }) as MessageListRow

describe('mergeByDate', () => {
  it('keeps one account in its relevance order', () => {
    expect(mergeByDate([[row(1, 10), row(2, 30)], []], 5).map((r) => r.id)).toEqual([1, 2])
  })
  it('merges several accounts newest first, capped', () => {
    expect(mergeByDate([[row(1, 10), row(2, 30)], [row(3, 20, 2)]], 2).map((r) => r.id)).toEqual([2, 3])
  })
})
