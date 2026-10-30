import { describe, expect, it } from 'vitest'
import { threadsByAccount } from './accountGroups.js'

describe('threadsByAccount', () => {
  it('groups thread ids under the account that owns each row, once each', () => {
    const rows = [
      { thread_id: '<a>', account_id: 1 },
      { thread_id: '<list>', account_id: 2 },
      { thread_id: '<list>', account_id: 1 },
      { thread_id: '<a>', account_id: 1 },
      { thread_id: null, account_id: 2 }
    ]
    expect([...threadsByAccount(rows)]).toEqual([
      [1, ['<a>', '<list>']],
      [2, ['<list>']]
    ])
  })
})
