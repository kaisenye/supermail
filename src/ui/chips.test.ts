import { describe, expect, it } from 'vitest'
import { CHIPS, viewQuery } from './chips.js'

describe('viewQuery', () => {
  it('ANDs the split query and the chip query', () => {
    expect(viewQuery('is:important', 'unread')).toBe('is:important is:unread')
    expect(viewQuery('', 'needsReply')).toBe('is:needs-reply')
    expect(viewQuery('from:bob', null)).toBe('from:bob')
    expect(viewQuery('', null)).toBe('')
  })
  it('offers Unread, Needs reply, Waiting and Starred', () => {
    expect(CHIPS.map((c) => c.label)).toEqual(['Needs reply', 'Waiting', 'Unread', 'Starred'])
  })
})
