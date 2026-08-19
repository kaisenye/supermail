import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import { listInbox, upsertMessage } from './repo.js'

const ACC = 1
let folder: number

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'threaded-')), 't.db'))
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (?,'a@b.test')").run(ACC)
  folder = Number(
    db
      .prepare("INSERT INTO folders (account_id,path,name) VALUES (?,'INBOX','INBOX')")
      .run(ACC).lastInsertRowid
  )
})

/** uid doubles as the insertion order, so tests can control id vs date. */
function add(uid: number, thread: string, date: number, seen: boolean, subject = 's') {
  return upsertMessage({
    account_id: ACC,
    folder_id: folder,
    uid,
    message_id: `<m${uid}>`,
    thread_id: thread,
    in_reply_to: null,
    from_addr: 'x@y.test',
    from_name: null,
    to_addrs: null,
    cc_addrs: null,
    subject,
    date,
    snippet: null,
    flags: seen ? '["\\\\Seen"]' : '[]'
  })
}

describe('threaded list', () => {
  it('collapses a thread to one row carrying its message count', () => {
    add(1, 't1', 100, true)
    add(2, 't1', 200, true)
    add(3, 't2', 300, true)
    const rows = listInbox(folder)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.thread_count)).toEqual([1, 2])
  })

  it('counts a thread unread when any message in it is', () => {
    add(1, 't1', 100, false)
    add(2, 't1', 200, true)
    const [row] = listInbox(folder)
    expect(row.thread_count).toBe(2)
    expect(row.thread_unread).toBe(1)
  })

  it('reports zero unread once every message is seen', () => {
    add(1, 't1', 100, true)
    add(2, 't1', 200, true)
    expect(listInbox(folder)[0].thread_unread).toBe(0)
  })

  /** id follows sync order, so the newest row must be chosen by date. */
  it('shows the newest message even when it synced first', () => {
    add(1, 't1', 900, true, 'newest')
    add(2, 't1', 100, true, 'oldest')
    const [row] = listInbox(folder)
    expect(row.subject).toBe('newest')
  })

  it('orders threads by their newest message', () => {
    add(1, 'old', 100, true, 'old-thread')
    add(2, 'new', 500, true, 'new-thread')
    add(3, 'old', 900, true, 'old-thread-reply')
    expect(listInbox(folder).map((r) => r.subject)).toEqual(['old-thread-reply', 'new-thread'])
  })

  it('paginates over threads, not messages', () => {
    for (let i = 1; i <= 6; i++) add(i, `t${i % 3}`, i * 100, true)
    expect(listInbox(folder, 2, 0)).toHaveLength(2)
    expect(listInbox(folder, 2, 2)).toHaveLength(1)
  })

  it('returns nothing for an empty folder', () => {
    expect(listInbox(folder)).toEqual([])
  })
})
