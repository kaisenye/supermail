import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { countView, listView, unreadCounts } from '../store/listRows.js'
import { upsertMessage } from '../store/repo.js'
import { splitCounts } from '../store/splits.js'
import { setMute, setVip, toggleMute, toggleVip } from './localRules.js'

let uid = 0
const put = (folder: number, thread: string, from = 'x@y.test', flags = '[]') =>
  upsertMessage({
    account_id: 1, folder_id: folder, uid: ++uid, message_id: `<${uid}@t>`, thread_id: thread,
    in_reply_to: null, from_addr: from, from_name: null, to_addrs: '[]', cc_addrs: '[]',
    subject: thread, date: uid, snippet: null, flags
  })
const mute = (id: number) => toggleMute([id])?.muted ?? null
const vip = (id: number) => toggleVip([id])?.vip ?? null

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'rules-')), 't.db'))
  uid = 0
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
  getDb().prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox'),(2,1,'Archive','archive')").run()
})

describe('mute', () => {
  it('keeps the thread, and new replies to it, out of the Inbox only', () => {
    const a = put(1, 'a')
    put(1, 'b')
    put(2, 'a')
    expect(mute(a)).toBe(true)
    put(1, 'a') // a new reply
    expect(listView(1).map((r) => r.subject)).toEqual(['b'])
    expect(listView(2).map((r) => r.subject)).toEqual(['a'])
    expect(mute(a)).toBe(false)
    expect(listView(1).map((r) => r.subject)).toEqual(['a', 'b'])
  })

  it('cannot mute a message without a Message-ID', () => {
    const id = Number(
      getDb().prepare("INSERT INTO messages (account_id,folder_id,uid,thread_id) VALUES (1,1,999,'z')").run()
        .lastInsertRowid
    )
    expect(mute(id)).toBeNull()
  })
})

describe('mute, several targets', () => {
  it('mutes every checked thread in one call, once per thread', () => {
    const a = put(1, 'a')
    const a2 = put(1, 'a')
    const b = put(1, 'b')
    put(1, 'c')
    const r = toggleMute([a, a2, b])
    expect(r).toEqual({ muted: true, changed: [a, b] })
    expect(listView(1).map((x) => x.subject)).toEqual(['c'])
  })

  it('mutes all when some are already muted, and changes only the others', () => {
    const a = put(1, 'a')
    const b = put(1, 'b')
    mute(a)
    expect(toggleMute([a, b])).toEqual({ muted: true, changed: [b] })
    // Undo reverses exactly what changed: a stays muted.
    expect(setMute([b], false)).toEqual([b])
    expect(listView(1).map((x) => x.subject)).toEqual(['b'])
  })

  it('unmutes all when every target is already muted', () => {
    const a = put(1, 'a')
    const b = put(1, 'b')
    toggleMute([a, b])
    expect(toggleMute([a, b])).toEqual({ muted: false, changed: [a, b] })
    expect(listView(1).map((x) => x.subject)).toEqual(['b', 'a'])
  })

  it('skips targets without a Message-ID, and is null when none has one', () => {
    const a = put(1, 'a')
    const bare = Number(
      getDb().prepare("INSERT INTO messages (account_id,folder_id,uid,thread_id) VALUES (1,1,999,'z')").run()
        .lastInsertRowid
    )
    expect(toggleMute([bare])).toBeNull()
    expect(toggleMute([bare, a])).toEqual({ muted: true, changed: [a] })
  })
})

describe('VIP, several targets', () => {
  it('marks every distinct sender, and undo removes only the new ones', () => {
    const a = put(1, 'a', 'one@x.test')
    const a2 = put(1, 'a2', 'ONE@x.test')
    const b = put(1, 'b', 'two@x.test')
    const c = put(1, 'c', 'three@x.test')
    vip(c)
    const r = toggleVip([a, a2, b, c])
    expect(r).toEqual({ vip: true, changed: [a, b] })
    expect(setVip(r!.changed, false)).toEqual([a, b])
    expect(getDb().prepare('SELECT address FROM vip_senders').all()).toEqual([{ address: 'three@x.test' }])
    expect(toggleVip([c])).toEqual({ vip: false, changed: [c] })
  })
})

describe('VIP', () => {
  it('toggles the sender of a message', () => {
    const a = put(1, 'a', 'Boss@X.test')
    expect(vip(a)).toBe(true)
    expect(getDb().prepare('SELECT address FROM vip_senders').all()).toEqual([{ address: 'boss@x.test' }])
    expect(listView(1, { query: 'is:vip' })).toHaveLength(1)
    expect(vip(a)).toBe(false)
  })

  // The UI reloads counts after a toggle (loadRows), so the Important split must follow vip_senders at once.
  it('moves the sender into and out of the Important split count', () => {
    const a = put(1, 'a', 'boss@x.test')
    put(1, 'b')
    expect(splitCounts(1).important).toBe(0)
    vip(a)
    expect(splitCounts(1).important).toBe(1)
    vip(a)
    expect(splitCounts(1).important).toBe(0)
  })
})

describe('mute counts', () => {
  // The UI reloads the total and split counts after a mute (loadRows), not just the page.
  it('drops the muted thread from the Inbox total and the split counts', () => {
    const a = put(1, 'a')
    put(1, 'b')
    expect(countView(1)).toBe(2)
    expect(splitCounts(1).all).toBe(2)
    mute(a)
    expect(countView(1)).toBe(1)
    expect(splitCounts(1).all).toBe(1)
    mute(a)
    expect(countView(1)).toBe(2)
  })
})

describe('unread counts', () => {
  const SEEN = '["\\\\Seen"]'
  it('drops a muted unread thread from the Inbox badge, and later replies do not raise it', () => {
    const a = put(1, 'a')
    put(1, 'b')
    put(1, 'c', 'x@y.test', SEEN)
    put(2, 'a')
    expect(unreadCounts(1)).toEqual({ 1: 2, 2: 1 })
    mute(a)
    expect(unreadCounts(1)).toEqual({ 1: 1, 2: 1 })
    put(1, 'a') // a new unread reply to the muted thread
    expect(unreadCounts(1)).toEqual({ 1: 1, 2: 1 })
    mute(a)
    expect(unreadCounts(1)).toEqual({ 1: 3, 2: 1 })
  })

  it('ignores a Seen flag whatever its case, and other accounts', () => {
    put(1, 'a', 'x@y.test', '["\\\\SEEN"]')
    put(1, 'b')
    expect(unreadCounts(1)).toEqual({ 1: 1 })
    expect(unreadCounts(2)).toEqual({})
  })
})
