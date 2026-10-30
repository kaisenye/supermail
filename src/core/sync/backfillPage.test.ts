import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { insertMoveJob, queuedSourceUids } from '../store/moveJobs.js'
import type { AccountConfig } from '../accounts/config.js'
import { setSetting } from '../store/repo.js'
import { backfillCeiling, backfillFolder, backfillPage, backfillPlan, forwardCutoff, refreshFolderNow } from './syncEngine.js'

const fake = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('./imap.js', async (orig) => ({
  ...(await orig<typeof import('./imap.js')>()),
  createClient: async () => fake.client
}))

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

describe('backfill around a low server-search hit', () => {
  beforeEach(() => {
    closeDb()
    initDb(join(mkdtempSync(join(tmpdir(), 'backfillgap-')), 't.db'))
    const db = getDb()
    db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@gmail.com')").run()
    db.prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox')").run()
    const ins = db.prepare(
      "INSERT INTO messages (account_id, folder_id, uid, message_id, flags) VALUES (1, 1, ?, ?, '[]')"
    )
    // Forward sync stored 1000..1002; server search then stored old uid 5.
    for (const uid of [1000, 1001, 1002, 5]) ins.run(uid, `<${uid}@t>`)
  })

  const server = [1, 2, 3, 4, 5, 6, 7, 997, 998, 999, 1000, 1001, 1002]

  it('pages the uids between the hit and the synced window, newest first', () => {
    expect(backfillPlan(1, server, [], 3)).toEqual({ uids: [999, 998, 997], more: true })
    expect(backfillPlan(1, server, [], 100)).toEqual({ uids: [999, 998, 997, 7, 6, 4, 3, 2, 1], more: false })
    expect(backfillPlan(1, server, [998], 100).uids).not.toContain(998)
  })

  it('keeps going when uid 1 is local but newer mail is not', () => {
    getDb()
      .prepare("INSERT INTO messages (account_id, folder_id, uid, message_id, flags) VALUES (1, 1, 1, '<1@t>', '[]')")
      .run()
    expect(backfillPlan(1, server, [], 2)).toEqual({ uids: [999, 998], more: true })
  })

  it('backfillFolder searches up to the newest local uid and fetches the gap', async () => {
    const searched: unknown[] = []
    const fetched: string[] = []
    fake.client = {
      connect: async () => {},
      logout: async () => {},
      mailbox: { uidValidity: 7n },
      getMailboxLock: async () => ({ release() {} }),
      search: async (q: unknown) => {
        searched.push(q)
        return server
      },
      fetch: async function* (range: string) {
        fetched.push(range)
      }
    }
    const r = await backfillFolder(1, {} as AccountConfig, { id: 1, path: 'INBOX', uidvalidity: 7, last_uid: 1002 }, 2)
    expect(searched).toEqual([{ uid: '1:1002' }])
    expect(fetched).toEqual(['999,998'])
    expect(r).toEqual({ messages: 0, more: true })
  })

  it('backfillFolder stores nothing when the mailbox was renumbered or never stamped', async () => {
    const touched: string[] = []
    fake.client = {
      connect: async () => {},
      logout: async () => {},
      mailbox: { uidValidity: 8n },
      getMailboxLock: async () => ({ release() {} }),
      search: async () => {
        touched.push('search')
        return server
      },
      fetch: async function* () {
        touched.push('fetch')
      }
    }
    const stale = await backfillFolder(1, {} as AccountConfig, { id: 1, path: 'INBOX', uidvalidity: 7, last_uid: 1002 }, 2)
    const unknown = await backfillFolder(1, {} as AccountConfig, { id: 1, path: 'INBOX', uidvalidity: null, last_uid: 1002 }, 2)
    // more stays true so the history worker never marks the folder complete.
    expect(stale).toEqual({ messages: 0, more: true })
    expect(unknown).toEqual({ messages: 0, more: true })
    expect(touched).toEqual([])
  })
})

describe('backfill of a folder with only mail older than the sync window', () => {
  beforeEach(() => {
    closeDb()
    initDb(join(mkdtempSync(join(tmpdir(), 'backfillold-')), 't.db'))
    const db = getDb()
    db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
    // Forward sync fetched uids 1..3, stored none (all past the cutoff), set last_uid 3.
    db.prepare("INSERT INTO folders (id,account_id,path,last_uid,uidvalidity) VALUES (1,1,'Old',3,7)").run()
  })

  const oldDate = new Date('2015-01-01T00:00:00Z')
  const client = (searched: unknown[]) => ({
    connect: async () => {},
    logout: async () => {},
    mailbox: { uidValidity: 7n },
    getMailboxLock: async () => ({ release() {} }),
    search: async (q: unknown) => {
      searched.push(q)
      return [1, 2, 3]
    },
    fetch: async function* (range: string) {
      for (const uid of range.split(',').map(Number)) {
        yield { uid, flags: new Set<string>(), envelope: { messageId: `<old${uid}@t>`, subject: `old ${uid}`, date: oldDate } }
      }
    }
  })

  it('pages back from last_uid when nothing is local, until it is done', async () => {
    const searched: unknown[] = []
    fake.client = client(searched)
    const folder = { id: 1, path: 'Old', uidvalidity: 7, last_uid: 3 }
    const first = await backfillFolder(1, {} as AccountConfig, folder, 2)
    expect(searched[0]).toEqual({ uid: '1:3' })
    expect(first).toEqual({ messages: 2, more: true })
    const second = await backfillFolder(1, {} as AccountConfig, folder, 2)
    expect(second).toEqual({ messages: 1, more: false })
    const uids = getDb().prepare('SELECT uid FROM messages WHERE folder_id = 1 ORDER BY uid').all()
    expect(uids).toEqual([{ uid: 1 }, { uid: 2 }, { uid: 3 }])
  })

  it('leaves a folder the forward sync never reached alone', async () => {
    const searched: unknown[] = []
    fake.client = client(searched)
    const r = await backfillFolder(1, {} as AccountConfig, { id: 1, path: 'Old', uidvalidity: 7, last_uid: 0 }, 2)
    expect(r).toEqual({ messages: 0, more: false })
    expect(searched).toEqual([])
  })
})

describe('full offline history keeps mail with an old date', () => {
  beforeEach(() => {
    closeDb()
    initDb(join(mkdtempSync(join(tmpdir(), 'fullhist-')), 't.db'))
    const db = getDb()
    db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
    db.prepare("INSERT INTO folders (id,account_id,path,last_uid,uidvalidity) VALUES (1,1,'INBOX',10,7)").run()
  })

  // A 2019 mail moved back into INBOX: new uid 11, old date.
  const moved = () => ({
    connect: async () => {},
    logout: async () => {},
    mailbox: { uidValidity: 7n, uidNext: 12, exists: 11 },
    noop: async () => {},
    getMailboxLock: async () => ({ release() {} }),
    fetch: async function* () {
      yield {
        uid: 11,
        flags: new Set<string>(),
        envelope: { messageId: '<2019@t>', subject: 'from 2019', date: new Date('2019-03-01T00:00:00Z') }
      }
    }
  })
  const stored = () => getDb().prepare('SELECT uid FROM messages WHERE folder_id = 1').all()

  it('the forward pass stores it while full history is on (the default)', async () => {
    expect(forwardCutoff(760)).toBe(0)
    const n = await refreshFolderNow(moved() as never, 1, { id: 1, path: 'INBOX', last_uid: 10 })
    expect(n).toBe(1)
    expect(stored()).toEqual([{ uid: 11 }])
  })

  it('the sinceDays window applies again only when full history is off', async () => {
    setSetting('full_history', '0')
    expect(forwardCutoff(760, 1_000_000_000_000)).toBe(1_000_000_000_000 - 760 * 86_400_000)
    const n = await refreshFolderNow(moved() as never, 1, { id: 1, path: 'INBOX', last_uid: 10 })
    expect(n).toBe(0)
    expect(stored()).toEqual([])
  })

  // History off: the forward pass drops the old mail but moves last_uid past
  // it. If history was already complete, nothing would ever revisit the gap.
  it('reopens a complete folder\'s history when the forward pass drops old mail', async () => {
    const complete = () =>
      (getDb().prepare('SELECT history_complete FROM folders WHERE id = 1').get() as { history_complete: number })
        .history_complete
    getDb().prepare('UPDATE folders SET history_complete = 1 WHERE id = 1').run()
    setSetting('full_history', '0')
    await refreshFolderNow(moved() as never, 1, { id: 1, path: 'INBOX', last_uid: 10 })
    expect(stored()).toEqual([])
    expect(complete()).toBe(0)
  })

  it('leaves history complete when nothing was dropped', async () => {
    getDb().prepare('UPDATE folders SET history_complete = 1 WHERE id = 1').run()
    await refreshFolderNow(moved() as never, 1, { id: 1, path: 'INBOX', last_uid: 10 })
    expect(stored()).toEqual([{ uid: 11 }])
    expect(
      (getDb().prepare('SELECT history_complete FROM folders WHERE id = 1').get() as { history_complete: number })
        .history_complete
    ).toBe(1)
  })

  it('backfill searches up to last_uid when it is above the newest local uid', async () => {
    expect(backfillCeiling(null, 0)).toBeNull()
    expect(backfillCeiling(5, 0)).toBe(5)
    expect(backfillCeiling(5, 11)).toBe(11)
    expect(backfillCeiling(20, 11)).toBe(20)
    // uid 5 local, last_uid 11: the skipped 11 is still missing.
    getDb()
      .prepare("INSERT INTO messages (account_id, folder_id, uid, message_id, flags) VALUES (1, 1, 5, '<5@t>', '[]')")
      .run()
    const searched: unknown[] = []
    const fetched: string[] = []
    fake.client = {
      connect: async () => {},
      logout: async () => {},
      mailbox: { uidValidity: 7n },
      getMailboxLock: async () => ({ release() {} }),
      search: async (q: unknown) => {
        searched.push(q)
        return [5, 11]
      },
      fetch: async function* (range: string) {
        fetched.push(range)
      }
    }
    const r = await backfillFolder(1, {} as AccountConfig, { id: 1, path: 'INBOX', uidvalidity: 7, last_uid: 11 }, 10)
    expect(searched).toEqual([{ uid: '1:11' }])
    expect(fetched).toEqual(['11'])
    expect(r.more).toBe(false)
  })
})
