import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { insertMoveJob, queuedSourceUids } from '../store/moveJobs.js'
import type { ImapFlow } from 'imapflow'
import { gmailRawQuery, gmailSearchUids, missingUids } from './serverSearch.js'
import { fetchUids, serverSearchFolder } from './syncEngine.js'

describe('gmailRawQuery', () => {
  it('drops the operators only the local list understands', () => {
    expect(gmailRawQuery('from:ann is:needs-reply invoice')).toBe('from:ann invoice')
    expect(gmailRawQuery('-is:waiting x OR y')).toBe('x OR y')
    expect(gmailRawQuery('is:unread has:attachment')).toBe('is:unread has:attachment')
  })
})

describe('missingUids', () => {
  beforeEach(() => {
    closeDb()
    initDb(join(mkdtempSync(join(tmpdir(), 'serversearch-')), 't.db'))
    const db = getDb()
    db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@gmail.com')").run()
    db.prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox')").run()
    const ins = db.prepare(
      "INSERT INTO messages (account_id, folder_id, uid, message_id, flags) VALUES (1, 1, ?, ?, '[]')"
    )
    ins.run(5, '<5@t>')
    ins.run(7, '<7@t>')
  })

  it('keeps server hits with no local row, newest first, capped', () => {
    expect(missingUids(1, [9, 5, 8, 7, 9], 2)).toEqual([9, 8])
    expect(missingUids(1, [5, 7], 10)).toEqual([])
    expect(missingUids(1, [], 10)).toEqual([])
  })

  it('skips the source uid of a move not yet on the server', () => {
    // Archived optimistically: the local row moved, the server still has uid 9 in INBOX.
    insertMoveJob({ account_id: 1, from_path: 'INBOX', uid: 9, to_path: 'Archive', uidvalidity: 1 })
    const queued = queuedSourceUids(1, 'INBOX')
    expect(missingUids(1, [9, 8], 10, queued)).toEqual([8])
    // A move held in the undo window is skipped the same way.
    expect(missingUids(1, [9, 8, 6], 10, [...queued, 6])).toEqual([8])
    // Another mailbox's queued move does not hide this one's hit.
    expect(missingUids(1, [9, 8], 10, queuedSourceUids(1, '[Gmail]/Sent Mail'))).toEqual([9, 8])
  })
})

describe('server search under a changed UIDVALIDITY', () => {
  beforeEach(() => {
    closeDb()
    initDb(join(mkdtempSync(join(tmpdir(), 'serversearch-uv-')), 't.db'))
    getDb().prepare("INSERT INTO accounts (id,email) VALUES (1,'me@gmail.com')").run()
  })

  /** A mailbox numbered under `uidValidity` whose search hits are `hits`. */
  function fakeClient(uidValidity: bigint, hits: number[]) {
    const fetch = vi.fn(async function* () {})
    const client = {
      mailbox: { uidValidity },
      getMailboxLock: async () => ({ release() {} }),
      search: async () => hits,
      fetch
    }
    return { client: client as unknown as ImapFlow, fetch }
  }

  it('returns the uidvalidity the hits are numbered under', async () => {
    const { client } = fakeClient(42n, [3, 9])
    expect(await gmailSearchUids(client, 'INBOX', 'x')).toEqual({ uids: [3, 9], uidValidity: 42 })
  })

  it('skips a folder whose uidvalidity changed or was never recorded', async () => {
    const { client, fetch } = fakeClient(42n, [3, 9])
    const changed = { id: 1, path: 'INBOX', uidvalidity: 7 }
    expect(await serverSearchFolder(client, 1, changed, 'x', [])).toBe(0)
    const unknown = { id: 1, path: 'INBOX', uidvalidity: null }
    expect(await serverSearchFolder(client, 1, unknown, 'x', [])).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fetches the missing hits when uidvalidity matches', async () => {
    const { client, fetch } = fakeClient(42n, [3, 9])
    await serverSearchFolder(client, 1, { id: 1, path: 'INBOX', uidvalidity: 42 }, 'x', [])
    expect(fetch).toHaveBeenCalledWith('9,3', expect.anything(), { uid: true })
  })

  it('fetchUids stores nothing if the mailbox renumbered after the search', async () => {
    const { client, fetch } = fakeClient(43n, [])
    expect(await fetchUids(client, 1, { id: 1, path: 'INBOX' }, [9, 3], 42)).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })
})
