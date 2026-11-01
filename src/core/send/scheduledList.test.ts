import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { cancelOutbox, enqueueOutbox, listScheduledOutbox } from './outbox.js'

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'schedlist-')), 't.db'))
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (1,'a@x.test'),(2,'b@x.test'),(3,'c@x.test')").run()
})

const queue = (account_id: number, send_at: number, subject: string): number =>
  enqueueOutbox({ account_id, draft_message_id: null, to_addrs: 'r@x.test', subject, send_at }).id

describe('scheduled sends across accounts', () => {
  it('lists a send queued under a non-active account (a reply to a search result)', () => {
    queue(1, 5000, 'from A')
    queue(2, 3000, 'from B')
    const rows = listScheduledOutbox([1, 2], 1000)
    expect(rows.map((r) => [r.account_id, r.subject])).toEqual([
      [2, 'from B'],
      [1, 'from A']
    ])
  })

  it('leaves out accounts not listed, sends inside the undo window, and non-pending rows', () => {
    queue(3, 5000, 'removed account')
    queue(1, 900, 'inside undo window')
    const cancelled = queue(2, 6000, 'cancelled')
    cancelOutbox(cancelled)
    queue(2, 7000, 'kept')
    expect(listScheduledOutbox([1, 2], 1000).map((r) => r.subject)).toEqual(['kept'])
  })

  it('returns nothing for no accounts', () => {
    queue(1, 5000, 'x')
    expect(listScheduledOutbox([], 0)).toEqual([])
  })
})
