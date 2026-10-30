import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import { upsertMessage } from './repo.js'
import { searchMessages } from './search.js'

let uid = 0

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'searchops-')), 't.db'))
  uid = 0
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test'),(2,'you@y.test')").run()
  db.prepare(
    `INSERT INTO folders (id,account_id,path,name,role) VALUES
       (1,1,'INBOX','INBOX','inbox'),(2,1,'Archive','Archive','archive'),
       (3,1,'Projects','Projects',NULL),(4,2,'INBOX','INBOX','inbox')`
  ).run()
})

function add(o: { subject: string; body?: string; from?: string; folder?: number; account?: number; date?: number }): number {
  uid++
  return upsertMessage({
    account_id: o.account ?? 1,
    folder_id: o.folder ?? 1,
    uid,
    message_id: `<s${uid}@t>`,
    thread_id: `<s${uid}@t>`,
    in_reply_to: null,
    from_addr: o.from ?? 'x@z.test',
    from_name: null,
    to_addrs: '[]',
    cc_addrs: '[]',
    subject: o.subject,
    date: o.date ?? uid * 1000,
    snippet: null,
    body_text: o.body ?? null
  })
}

const ids = (q: string, account = 1) =>
  searchMessages(account, q)
    .map((r) => r.id)
    .sort((a, b) => a - b)

describe('search operators', () => {
  it('ORs terms and operators, Gmail-style (OR binds tighter than AND)', () => {
    const a = add({ subject: 'invoice march', from: 'ann@z.test' })
    const b = add({ subject: 'receipt april', from: 'bob@z.test' })
    add({ subject: 'hello', from: 'cy@z.test' })
    expect(ids('invoice OR receipt')).toEqual([a, b])
    expect(ids('from:ann OR from:bob')).toEqual([a, b])
    expect(ids('march invoice OR receipt')).toEqual([a])
  })

  it('drops a -term and a -operator', () => {
    add({ subject: 'invoice march', from: 'ann@z.test' })
    const may = add({ subject: 'invoice may', from: 'bob@z.test' })
    expect(ids('invoice -march')).toEqual([may])
    expect(ids('invoice -from:ann')).toEqual([may])
  })

  it('matches a "phrase" as words in that order', () => {
    const a = add({ subject: 'quarterly report due' })
    add({ subject: 'report on the quarterly numbers' })
    expect(ids('"quarterly report"')).toEqual([a])
  })

  it('filters in: by role or folder name; in:done means the Done folder', () => {
    const inbox = add({ subject: 'plan' })
    const done = add({ subject: 'plan', folder: 2 })
    const proj = add({ subject: 'plan', folder: 3 })
    expect(ids('plan in:inbox')).toEqual([inbox])
    expect(ids('plan in:done')).toEqual([done])
    expect(ids('plan in:projects')).toEqual([proj])
  })

  it('treats in:constructor / in:__proto__ as a folder name, not a prototype key', () => {
    add({ subject: 'plan' })
    expect(() => ids('plan in:constructor')).not.toThrow()
    expect(ids('plan in:constructor')).toEqual([])
    expect(ids('plan in:__proto__')).toEqual([])
    expect(ids('plan in:tostring')).toEqual([])
  })

  it('filters label: on the Gmail labels of the same account', () => {
    const a = add({ subject: 'plan' })
    add({ subject: 'plan' })
    const db = getDb()
    const label = Number(db.prepare("INSERT INTO labels (account_id, name) VALUES (1, 'Work')").run().lastInsertRowid)
    db.prepare('INSERT INTO message_labels (message_id, label_id) VALUES (?, ?)').run(a, label)
    expect(ids('label:work')).toEqual([a])
    expect(ids('plan -label:Work').length).toBe(1)
  })

  it('filters before: and after: by day, and treats a bad date as text', () => {
    const jan10 = add({ subject: 'plan', date: new Date(2026, 0, 10, 12).getTime() })
    const jan20 = add({ subject: 'plan', date: new Date(2026, 0, 20, 12).getTime() })
    expect(ids('plan after:2026/01/15')).toEqual([jan20])
    expect(ids('plan before:2026-01-15')).toEqual([jan10])
    expect(ids('after:2026/01/20')).toEqual([jan20])
    expect(ids('plan before:2026-13-40')).toEqual([])
  })

  it('keeps every search inside its account', () => {
    const mine = add({ subject: 'budget' })
    add({ subject: 'budget', account: 2, folder: 4 })
    expect(ids('budget OR nothing')).toEqual([mine])
  })
})
