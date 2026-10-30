import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { upsertMessage } from '../store/repo.js'
import { markDirtyByMessageId } from '../store/listRows.js'
import { zeroCandidates } from './zero.js'

const DAY = 86_400_000
const NOW = 100 * DAY
let uid = 0
const put = (thread: string, ageDays: number, flags: string[]) =>
  upsertMessage({
    account_id: 1, folder_id: 1, uid: ++uid, message_id: `<${uid}@t>`, thread_id: thread,
    in_reply_to: null, from_addr: 'x@y.test', from_name: null, to_addrs: '[]', cc_addrs: '[]',
    subject: thread, date: NOW - ageDays * DAY, snippet: null, flags: JSON.stringify(flags)
  })

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'zero-')), 't.db'))
  uid = 0
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
  getDb().prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox')").run()
})

describe('zeroCandidates', () => {
  it('picks conversations older than N days, optionally keeping unread and starred ones', () => {
    const old = put('old', 10, ['\\Seen'])
    const unread = put('unread', 10, [])
    const starred = put('starred', 10, ['\\Seen', '\\Flagged'])
    put('new', 1, ['\\Seen'])
    const keepBoth = { olderThanDays: 7, keepUnread: true, keepStarred: true }
    expect(zeroCandidates(1, keepBoth, NOW)).toEqual([old])
    expect(zeroCandidates(1, { ...keepBoth, keepUnread: false, keepStarred: false }, NOW).sort()).toEqual(
      [old, unread, starred].sort()
    )
  })

  it('treats a thread whose reminder just fired as fresh, as the Inbox shows it', () => {
    const fired = put('fired', 30, ['\\Seen'])
    getDb()
      .prepare('INSERT INTO reminders (account_id,message_id,remind_at,created_at,fired_at) VALUES (?,?,?,?,?)')
      .run(1, `<${fired}@t>`, NOW - DAY, NOW - 20 * DAY, NOW - DAY)
    markDirtyByMessageId(1, `<${fired}@t>`)
    const old = put('old', 10, ['\\Seen'])
    expect(zeroCandidates(1, { olderThanDays: 7, keepUnread: false, keepStarred: false }, NOW)).toEqual([old])
  })

  it('skips hidden rows (muted, or reminded and not yet due)', () => {
    const muted = put('muted', 10, ['\\Seen'])
    getDb().prepare('INSERT INTO mutes (account_id,message_id,created_at) VALUES (?,?,?)').run(1, `<${muted}@t>`, NOW)
    markDirtyByMessageId(1, `<${muted}@t>`)
    const reminded = put('reminded', 10, ['\\Seen'])
    getDb()
      .prepare('INSERT INTO reminders (account_id,message_id,remind_at,created_at) VALUES (?,?,?,?)')
      .run(1, `<${reminded}@t>`, NOW + DAY, NOW - DAY)
    markDirtyByMessageId(1, `<${reminded}@t>`)
    const old = put('old', 10, ['\\Seen'])
    expect(zeroCandidates(1, { olderThanDays: 7, keepUnread: false, keepStarred: false }, NOW)).toEqual([old])
  })
})
