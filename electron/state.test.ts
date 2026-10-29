import { beforeEach, describe, expect, it } from 'vitest'
import type { AccountConfig } from '../src/core/accounts/index.js'
import {
  addAccount,
  clearNeedsReauth,
  getBootStatus,
  getActiveAccount,
  listAccounts,
  markNeedsReauth,
  removeAccount,
  setActiveAccount
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

describe('addAccount', () => {
  it('replacing a live account keeps its sidebar slot and the active account', () => {
    addAccount({ accountId: 1, email: 'a@gmail.com', config: config('a@gmail.com') })
    addAccount({ accountId: 2, email: 'b@gmail.com', config: config('b@gmail.com') })
    setActiveAccount(2)
    const fresh = config('a@gmail.com')
    addAccount({ accountId: 1, email: 'a@gmail.com', config: fresh })
    expect(listAccounts().map((a) => a.accountId)).toEqual([1, 2])
    expect(listAccounts()[0]?.config).toBe(fresh)
    expect(getActiveAccount()?.accountId).toBe(2)
  })
})
