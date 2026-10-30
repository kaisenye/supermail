import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import { upsertMessage } from './repo.js'
import { countUnified, inboxScopes, listUnified, unifiedSplitCounts, unifiedUnread } from './unified.js'

let uid = 0
let inbox1: number
let inbox2: number
let archive1: number

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'unified-')), 't.db'))
  uid = 0
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (1,'a@x.test'),(2,'b@y.test')").run()
  const ins = db.prepare('INSERT INTO folders (account_id,path,name,role) VALUES (?,?,?,?)')
  inbox1 = Number(ins.run(1, 'INBOX', 'INBOX', 'inbox').lastInsertRowid)
  inbox2 = Number(ins.run(2, 'INBOX', 'INBOX', 'inbox').lastInsertRowid)
  archive1 = Number(ins.run(1, 'Archive', 'Archive', 'archive').lastInsertRowid)
})

function add(account: number, folder: number, thread: string, date: number, o: { seen?: boolean; from?: string } = {}): number {
  uid++
  return upsertMessage({
    account_id: account,
    folder_id: folder,
    uid,
    message_id: `<m${uid}@t>`,
    thread_id: thread,
    in_reply_to: null,
    from_addr: o.from ?? 'them@z.test',
    from_name: null,
    to_addrs: '[]',
    cc_addrs: '[]',
    subject: `s${uid}`,
    date,
    snippet: null,
    flags: JSON.stringify(o.seen ? ['\\Seen'] : [])
  })
}

describe('unified inbox', () => {
  it("lists every account's Inbox newest first, each row tagged with its own account", () => {
    add(1, inbox1, '<a@t>', 100)
    add(2, inbox2, '<b@t>', 200)
    add(1, archive1, '<c@t>', 300)
    const rows = listUnified(inboxScopes([1, 2]))
    expect(rows.map((r) => [r.subject, r.account_id])).toEqual([
      ['s2', 2],
      ['s1', 1]
    ])
  })

  it('keeps a thread id that two accounts share as two rows', () => {
    // The same mailing list delivered to both accounts: thread ids collide.
    add(1, inbox1, '<list@t>', 100)
    add(2, inbox2, '<list@t>', 150)
    const rows = listUnified(inboxScopes([1, 2]))
    expect(rows.map((r) => r.account_id).sort()).toEqual([1, 2])
    expect(rows.every((r) => r.thread_count === 1)).toBe(true)
  })

  it('reads only the accounts it is given, and skips one with no Inbox yet', () => {
    add(1, inbox1, '<a@t>', 100)
    add(2, inbox2, '<b@t>', 200)
    expect(inboxScopes([1, 99])).toEqual([{ accountId: 1, folderId: inbox1 }])
    expect(listUnified(inboxScopes([1])).map((r) => r.account_id)).toEqual([1])
    expect(listUnified([])).toEqual([])
  })

  it('applies list queries per owning account (VIP is per account)', () => {
    add(1, inbox1, '<a@t>', 100, { from: 'boss@z.test' })
    add(2, inbox2, '<b@t>', 200, { from: 'boss@z.test' })
    getDb().prepare("INSERT INTO vip_senders (account_id, address) VALUES (1, 'boss@z.test')").run()
    const scopes = inboxScopes([1, 2])
    expect(listUnified(scopes, { query: 'is:vip' }).map((r) => r.account_id)).toEqual([1])
    expect(countUnified(scopes, { query: 'is:vip' })).toBe(1)
  })

  it('counts, pages, sums unread and counts splits like the list', () => {
    add(1, inbox1, '<a@t>', 100)
    add(2, inbox2, '<b@t>', 200, { seen: true })
    add(2, inbox2, '<c@t>', 300)
    const scopes = inboxScopes([1, 2])
    expect(countUnified(scopes)).toBe(3)
    expect(listUnified(scopes, { limit: 1, offset: 1 }).map((r) => r.subject)).toEqual(['s2'])
    expect(unifiedUnread(scopes)).toBe(2)
    expect(unifiedSplitCounts(scopes, 'is:unread').all).toBe(2)
  })

  it('pages across interleaved Inboxes in the same order as one sorted list', () => {
    const dates = [5, 12, 3, 40, 22, 9, 31, 17, 1, 28, 14, 35]
    dates.forEach((d, i) => add(i % 3 === 0 ? 2 : 1, i % 3 === 0 ? inbox2 : inbox1, `<p${i}@t>`, d))
    const scopes = inboxScopes([1, 2])
    const all = listUnified(scopes, { limit: 100 }).map((r) => r.date)
    expect(all).toEqual([...dates].sort((a, b) => b - a))
    const paged = [0, 1, 2, 3].flatMap((pg) => listUnified(scopes, { limit: 3, offset: pg * 3 }).map((r) => r.date))
    expect(paged).toEqual(all)
    expect(countUnified(scopes)).toBe(dates.length)
  })

  it('reads each Inbox through idx_list_rows_page, not one OR over every Inbox', () => {
    add(1, inbox1, '<a@t>', 100)
    const db = getDb()
    const prepare = db.prepare.bind(db)
    const seen: { sql: string; args: unknown[] }[] = []
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const st = prepare(sql)
      if (!sql.includes('list_rows lr')) return st
      const wrap = (fn: 'all' | 'get') => (...args: unknown[]) => {
        seen.push({ sql, args })
        return (st[fn] as (...a: unknown[]) => unknown)(...args)
      }
      return Object.assign(Object.create(st), { all: wrap('all'), get: wrap('get') })
    }) as typeof db.prepare)
    try {
      const scopes = inboxScopes([1, 2])
      listUnified(scopes, { limit: 50, query: 'is:unread' })
      countUnified(scopes)
    } finally {
      spy.mockRestore()
    }
    expect(seen.length).toBeGreaterThan(0)
    for (const { sql, args } of seen) {
      const plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail)
      expect(plan.some((d) => d.includes('idx_list_rows_page'))).toBe(true)
      expect(plan.some((d) => d.includes('MULTI-INDEX OR'))).toBe(false)
    }
  })
})
