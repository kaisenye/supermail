import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import { upsertMessage } from './repo.js'
import { contactProfile, threadCounterpart } from './contacts.js'

let uid = 0
const ids: Record<string, number> = {}

function add(key: string, o: { folder: number; thread: string; from: string; name?: string; to?: string[]; date: number }): void {
  uid++
  ids[key] = upsertMessage({
    account_id: 1,
    folder_id: o.folder,
    uid,
    message_id: `<${key}@t>`,
    thread_id: o.thread,
    in_reply_to: null,
    from_addr: o.from,
    from_name: o.name ?? null,
    to_addrs: JSON.stringify((o.to ?? []).map((address) => ({ address, name: null }))),
    cc_addrs: '[]',
    subject: key,
    date: o.date,
    snippet: null
  })
}

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'contacts-')), 't.db'))
  uid = 0
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
  db.prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox'),(2,1,'Sent','sent')").run()
  add('t1', { folder: 1, thread: '<t1>', from: 'ann@x.test', name: 'Ann', to: ['me@x.test'], date: 100 })
  add('t1reply', { folder: 2, thread: '<t1>', from: 'me@x.test', to: ['Ann@X.test'], date: 200 })
  add('t2', { folder: 1, thread: '<t2>', from: 'ann@x.test', to: ['me@x.test'], date: 300 })
  add('t3', { folder: 1, thread: '<t3>', from: 'bob@x.test', to: ['me@x.test'], date: 400 })
  add('t4', { folder: 2, thread: '<t4>', from: 'me@x.test', to: ['ann@x.test'], date: 500 })
})

describe('contactProfile', () => {
  it('counts mail both ways and how often you replied', () => {
    const p = contactProfile(1, 'ANN@x.test')!
    expect(p).toMatchObject({
      address: 'ann@x.test',
      name: 'Ann',
      received: 2,
      sent: 2,
      threads: 2,
      repliedThreads: 1,
      lastContact: 500
    })
    // Newest message per conversation with them.
    expect(p.recent.map((r) => r.id)).toEqual([ids.t4, ids.t2, ids.t1reply])
  })

  it('counts a thread you wrote in several times once, and keys loose messages by id', () => {
    add('t2r1', { folder: 2, thread: '<t2>', from: 'me@x.test', to: ['ann@x.test'], date: 310 })
    add('t2r2', { folder: 2, thread: '<t2>', from: 'ME@x.test', to: ['ann@x.test'], date: 320 })
    // No thread id: its own conversation, never matched to another loose message.
    getDb()
      .prepare('UPDATE messages SET thread_id = NULL WHERE id IN (?, ?)')
      .run(ids.t3, ids.t4)
    add('loose', { folder: 1, thread: '<x>', from: 'ann@x.test', to: ['me@x.test'], date: 600 })
    getDb().prepare('UPDATE messages SET thread_id = NULL WHERE id = ?').run(ids.loose)
    expect(contactProfile(1, 'ann@x.test')).toMatchObject({ threads: 3, repliedThreads: 2 })
  })

  it('stays fast on a large mailbox with many threads', () => {
    const db = getDb()
    const ins = db.prepare(
      `INSERT INTO messages (account_id, folder_id, uid, message_id, thread_id, from_addr, to_addrs, cc_addrs, subject, date)
       VALUES (1, ?, ?, ?, ?, ?, '[]', '[]', 's', ?)`
    )
    db.transaction(() => {
      let u = 10_000
      for (let i = 0; i < 40_000; i++) ins.run(1, u++, `<f${i}@t>`, `<o${i % 8000}>`, `x${i % 50}@x.test`, i)
      for (let i = 0; i < 1500; i++) {
        ins.run(1, u++, `<c${i}@t>`, `<c${i}>`, 'cara@x.test', i)
        if (i % 3 === 0) ins.run(2, u++, `<r${i}@t>`, `<c${i}>`, 'me@x.test', i + 1)
      }
    })()
    const t0 = performance.now()
    const p = contactProfile(1, 'cara@x.test')!
    const ms = performance.now() - t0
    expect(p).toMatchObject({ threads: 1500, repliedThreads: 500 })
    expect(ms).toBeLessThan(1000)
  })

  it('returns null without an address or an account', () => {
    expect(contactProfile(1, ' ')).toBeNull()
    expect(contactProfile(9, 'ann@x.test')).toBeNull()
  })
})

describe('threadCounterpart', () => {
  it('is the newest sender who is not you, else the first recipient', () => {
    expect(threadCounterpart(1, '<t1>')).toBe('ann@x.test')
    expect(threadCounterpart(1, '<t4>')).toBe('ann@x.test')
    expect(threadCounterpart(1, '<none>')).toBeNull()
  })
})

describe('contactProfile query plans', () => {
  it('looks people up through idx_messages_from, never scanning the account', () => {
    const db = getDb()
    const sqls: string[] = []
    const prepare = db.prepare.bind(db)
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      sqls.push(sql)
      return prepare(sql)
    }) as typeof db.prepare)
    try {
      contactProfile(1, 'ann@x.test')
    } finally {
      spy.mockRestore()
    }
    const lookups = sqls.filter((s) => s.includes('@addr'))
    expect(lookups.length).toBeGreaterThan(0)
    for (const sql of lookups) {
      const plan = (
        prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ acct: 1, addr: 'ann@x.test', me: 'me@x.test', limit: 8 }) as {
          detail: string
        }[]
      ).map((r) => r.detail)
      expect(plan.some((d) => d.includes('idx_messages_from'))).toBe(true)
      expect(plan.filter((d) => /^SCAN m\b/.test(d))).toEqual([])
    }
  })
})
