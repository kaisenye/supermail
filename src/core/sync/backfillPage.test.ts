import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { insertMoveJob, queuedSourceUids } from '../store/moveJobs.js'
import { backfillPage } from './syncEngine.js'

describe('backfillPage', () => {
  it('skips uids still mid-move, newest first', () => {
    const raw = [1, 2, 3, 4, 5].map((uid) => ({ uid }))
    expect(backfillPage(raw, new Set([4, 5]), 2)).toEqual({ page: [{ uid: 3 }, { uid: 2 }], more: true })
    expect(backfillPage(raw, new Set([4, 5]), 10)).toEqual({ page: [{ uid: 3 }, { uid: 2 }, { uid: 1 }], more: false })
  })
})

describe('queuedSourceUids', () => {
  beforeEach(() => {
    closeDb()
    initDb(join(mkdtempSync(join(tmpdir(), 'movejobs-')), 't.db'))
    getDb().prepare("INSERT INTO accounts (id,email) VALUES (1,'a@x.test'),(2,'b@x.test')").run()
  })

  it('lists queued moves out of one mailbox of one account', () => {
    insertMoveJob({ account_id: 1, from_path: 'INBOX', uid: 7, to_path: 'Archive', uidvalidity: 1 })
    insertMoveJob({ account_id: 1, from_path: 'Sent', uid: 8, to_path: 'Archive', uidvalidity: 1 })
    insertMoveJob({ account_id: 2, from_path: 'INBOX', uid: 9, to_path: 'Archive', uidvalidity: 1 })
    expect(queuedSourceUids(1, 'INBOX')).toEqual([7])
  })
})
