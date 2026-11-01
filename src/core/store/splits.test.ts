import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearClassifications, saveClassification } from './ai.js'
import { closeDb, getDb, initDb } from './db.js'
import { countView, listView } from './listRows.js'
import { upsertMessage } from './repo.js'
import { deleteSplit, listSplits, saveSplit, splitCounts } from './splits.js'

const ME = 'me@x.test'
let uid = 0

function add(
  folder: number,
  o: { thread: string; from: string; to?: string; date: number; bulk?: boolean; seen?: boolean }
) {
  uid++
  upsertMessage({
    account_id: 1,
    folder_id: folder,
    uid,
    message_id: `<m${uid}@t>`,
    thread_id: o.thread,
    in_reply_to: null,
    from_addr: o.from,
    from_name: null,
    to_addrs: JSON.stringify([{ address: o.to ?? ME, name: null }]),
    cc_addrs: '[]',
    subject: o.thread,
    date: o.date,
    snippet: null,
    flags: o.seen ? '["\\\\Seen"]' : '[]',
    bulk: o.bulk ? 1 : 0
  })
}

const subjects = (query: string) => listView(1, { query }).map((r) => r.subject)

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'splits-')), 't.db'))
  uid = 0
  const db = getDb()
  db.prepare('INSERT INTO accounts (id,email) VALUES (1,?)').run(ME)
  db.prepare(
    "INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox'),(2,1,'Sent','sent')"
  ).run()
  add(2, { thread: 'friend', from: ME, to: 'friend@x.test', date: 50 }) // I once wrote to friend
  add(1, { thread: 'friend', from: 'friend@x.test', date: 100 })
  add(1, { thread: 'news', from: 'news@list.test', date: 200, bulk: true, seen: true })
  add(1, { thread: 'stranger', from: 'new@x.test', date: 300 })
  add(1, { thread: 'mine', from: 'boss@x.test', date: 10, seen: true })
  add(2, { thread: 'mine', from: ME, to: 'boss@x.test', date: 400 })
})

describe('split views', () => {
  it('puts people I reply to in Important and everything else in Other', () => {
    // Newest first by the Inbox copy's date: friend 100, mine 10.
    expect(subjects('is:important')).toEqual(['friend', 'mine'])
    expect(subjects('is:other')).toEqual(['stranger', 'news'])
  })

  it('promotes a VIP sender into Important', () => {
    getDb().prepare("INSERT INTO vip_senders (account_id,address) VALUES (1,'new@x.test')").run()
    expect(subjects('is:vip')).toEqual(['stranger'])
    expect(subjects('is:important')).toEqual(['stranger', 'friend', 'mine'])
  })

  it('filters needs-reply, waiting and unread on thread state', () => {
    expect(subjects('is:needs-reply')).toEqual(['stranger', 'friend'])
    expect(subjects('is:waiting')).toEqual(['mine'])
    expect(subjects('is:unread')).toEqual(['stranger', 'friend'])
    expect(countView(1, { query: 'is:important is:unread' })).toBe(1)
  })

  it('stores custom splits after the built-ins and counts each one', () => {
    const s = saveSplit({ name: 'Bosses', query: 'from:boss' })
    expect(listSplits().map((x) => x.id)).toEqual(['all', 'important', 'other', s.id])
    expect(splitCounts(1)).toEqual({ all: 4, important: 2, other: 2, [s.id]: 1 })
    expect(splitCounts(1, 'is:unread')).toMatchObject({ all: 2, important: 1 })
    saveSplit({ id: s.id, name: 'Boss', query: 'from:boss' })
    expect(listSplits().at(-1)?.name).toBe('Boss')
    deleteSplit(s.id)
    expect(listSplits()).toHaveLength(3)
    expect(() => saveSplit({ name: ' ', query: 'x' })).toThrow()
  })

  it('lets the classifier overrule the heuristic both ways, and drops back when cleared', () => {
    // Message ids follow insertion: <m2@t> is friend's Inbox mail, <m4@t> stranger's.
    saveClassification(1, '<m4@t>', { important: true, category: 'work', reason: 'Asks you a question', model: 'm' })
    saveClassification(1, '<m2@t>', { important: false, category: 'newsletter', reason: 'Automated digest', model: 'm' })
    expect(subjects('is:important')).toEqual(['stranger', 'mine'])
    expect(subjects('is:other')).toEqual(['news', 'friend'])
    expect(subjects('ai:work')).toEqual(['stranger'])
    clearClassifications()
    expect(subjects('is:important')).toEqual(['friend', 'mine'])
    expect(subjects('ai:work')).toEqual([])
  })

  it('keeps a VIP in Important whatever the classifier says', () => {
    getDb().prepare("INSERT INTO vip_senders (account_id,address) VALUES (1,'new@x.test')").run()
    saveClassification(1, '<m4@t>', { important: false, category: 'marketing', reason: 'Promotion', model: 'm' })
    expect(subjects('is:important')).toContain('stranger')
  })
})
