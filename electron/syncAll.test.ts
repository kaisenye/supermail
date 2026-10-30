import { describe, expect, it } from 'vitest'
import { syncAllAccounts, type AccountSyncResult } from './syncAll.js'

const acct = (accountId: number) => ({ accountId, email: `u${accountId}@x.com` })
const okRes = (messages: number): AccountSyncResult => ({
  ok: true,
  folders: 1,
  messages,
  reconciled: 0,
  errors: [],
  skipped: false
})

describe('syncAllAccounts', () => {
  it('keeps syncing later accounts after one fails', async () => {
    const ran: number[] = []
    const res = await syncAllAccounts([acct(1), acct(2), acct(3)], async (a) => {
      ran.push(a.accountId)
      return a.accountId === 1 ? { ok: false, error: 'needs sign-in' } : okRes(a.accountId)
    })
    expect(ran).toEqual([1, 2, 3])
    expect(res).toEqual({
      ok: true,
      folders: 2,
      messages: 5,
      reconciled: 0,
      errors: [{ folder: 'u1@x.com', message: 'needs sign-in' }],
      skipped: false
    })
  })

  it('fails only when every account failed', async () => {
    const res = await syncAllAccounts([acct(1), acct(2)], async (a) => ({
      ok: false,
      error: a.accountId === 1 ? 'offline' : 'needs sign-in'
    }))
    expect(res).toEqual({ ok: false, error: 'u1@x.com: offline; u2@x.com: needs sign-in' })
  })

  it('passes a lone account failure through unchanged', async () => {
    const res = await syncAllAccounts([acct(1)], async () => ({ ok: false, error: 'offline' }))
    expect(res).toEqual({ ok: false, error: 'offline' })
  })

  it('treats a skipped account as neither failure nor work', async () => {
    const res = await syncAllAccounts([acct(1), acct(2)], async (a) =>
      a.accountId === 1 ? { ...okRes(9), skipped: true } : okRes(2)
    )
    expect(res).toMatchObject({ ok: true, messages: 2, errors: [] })
  })
})
