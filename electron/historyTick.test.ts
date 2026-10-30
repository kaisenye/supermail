import { describe, expect, it, vi } from 'vitest'
import { createHistoryTick, forwardSynced } from './historyTick.js'
import type { FolderRole } from '../src/core/store/folderRoles.js'

type F = { id: number; path: string; role: FolderRole | null; uidvalidity: number | null; history_complete?: number }
const f = (id: number, path: string, role: FolderRole | null = null): F => ({ id, path, role, uidvalidity: 7 })

describe('history tick', () => {
  it('keeps backfilling later accounts after one throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ran: number[] = []
    const done: number[] = []
    const tick = createHistoryTick({
      accounts: () => [{ accountId: 1 }, { accountId: 2 }],
      folders: (a) => [f(a.accountId * 10, 'INBOX', 'inbox')],
      backfill: async (a) => {
        ran.push(a.accountId)
        if (a.accountId === 1) throw new Error('offline')
        return { more: false }
      },
      complete: (x) => done.push(x.id)
    })
    await tick()
    expect(ran).toEqual([1, 2])
    expect(done).toEqual([20])
  })

  it('sets a failing folder aside, moves on, and retries it after the backoff', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let t = 0
    const tried: string[] = []
    const tick = createHistoryTick({
      accounts: () => [{ accountId: 1 }],
      folders: () => [f(1, 'INBOX', 'inbox'), f(2, 'Gone')],
      backfill: async (_a, x) => {
        tried.push(x.path)
        if (x.path === 'INBOX') throw new Error('Mailbox does not exist')
        return { more: true }
      },
      complete: () => {},
      now: () => t,
      retryMs: 1000
    })
    await tick()
    t = 500
    await tick()
    t = 1000
    await tick()
    expect(tried).toEqual(['INBOX', 'Gone', 'INBOX'])
  })

  it('marks complete only when the folder has nothing older left', async () => {
    const done: number[] = []
    let more = true
    const tick = createHistoryTick({
      accounts: () => [{ accountId: 1 }],
      folders: () => [f(1, 'INBOX', 'inbox')],
      backfill: async () => ({ more }),
      complete: (x) => done.push(x.id)
    })
    await tick()
    expect(done).toEqual([])
    more = false
    await tick()
    expect(done).toEqual([1])
  })

  it('does not mark complete when another backfill held the account', async () => {
    const done: number[] = []
    const tick = createHistoryTick({
      accounts: () => [{ accountId: 1 }],
      folders: () => [f(1, 'INBOX', 'inbox')],
      backfill: async () => null,
      complete: (x) => done.push(x.id)
    })
    await tick()
    expect(done).toEqual([])
  })
})

describe('forwardSynced', () => {
  it('takes folders with local mail or a last_uid, not untouched ones', () => {
    expect(forwardSynced({ last_uid: 0 }, 12)).toBe(true)
    // All mail older than the sync window: no local rows, but the forward pass ran.
    expect(forwardSynced({ last_uid: 40 }, null)).toBe(true)
    expect(forwardSynced({ last_uid: 0 }, null)).toBe(false)
  })
})
