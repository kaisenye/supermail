import { beforeEach, describe, expect, it } from 'vitest'
import type { AccountConfig } from '../src/core/accounts/index.js'
import {
  addAccount,
  clearNeedsReauth,
  getBootStatus,
  listAccounts,
  markNeedsReauth,
  removeAccount
} from './state.js'

function config(email: string): AccountConfig {
  return { email, name: null, provider: 'gmail' } as unknown as AccountConfig
}

beforeEach(() => {
  for (const a of listAccounts()) removeAccount(a.accountId)
  clearNeedsReauth('a@gmail.com')
  clearNeedsReauth('b@gmail.com')
})

describe('needsReauth', () => {
  it('flags only the marked account in the boot status, ignoring case', () => {
    addAccount({ accountId: 1, email: 'A@gmail.com', config: config('A@gmail.com') })
    addAccount({ accountId: 2, email: 'b@gmail.com', config: config('b@gmail.com') })
    markNeedsReauth('a@GMAIL.com')
    const flags = getBootStatus().accounts.map((a) => [a.email, a.needsReauth])
    expect(flags).toEqual([
      ['A@gmail.com', true],
      ['b@gmail.com', false]
    ])
  })

  it('clears the flag after a new sign-in', () => {
    addAccount({ accountId: 1, email: 'a@gmail.com', config: config('a@gmail.com') })
    markNeedsReauth('a@gmail.com')
    clearNeedsReauth('A@Gmail.com')
    expect(getBootStatus().accounts[0]?.needsReauth).toBe(false)
  })
})
