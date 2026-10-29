import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import { moveMessage, upsertFolder, upsertMessage } from './repo.js'
import type { UpsertMessageInput } from './types.js'

const ACC = 1
let inbox: number
let trash: number

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'adopt-')), 't.db'))
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (?,'a@b.test')").run(ACC)
  inbox = upsertFolder({ account_id: ACC, name: 'INBOX', path: 'INBOX', uidvalidity: 1 }).id
  trash = upsertFolder({ account_id: ACC, name: 'Trash', path: 'Deleted Messages', uidvalidity: 1 }).id
})

const mail = (folder_id: number, uid: number, message_id = '<m1@x>'): UpsertMessageInput => ({
  account_id: ACC,
  folder_id,
  uid,
  message_id,
  thread_id: message_id,
  in_reply_to: null,
  from_addr: 'a@x',
  from_name: null,
  to_addrs: '[]',
  cc_addrs: '[]',
  subject: 'Hello',
  date: 1,
  snippet: null,
  flags: '[]'
})

const rowsIn = (folderId: number) =>
  getDb()
    .prepare('SELECT id, uid FROM messages WHERE folder_id = ? ORDER BY id')
    .all(folderId) as { id: number; uid: number | null }[]

describe('a moved message synced back from its new folder', () => {
  it('adopts the optimistic row instead of adding a duplicate', () => {
    const id = upsertMessage(mail(inbox, 7))
    // Optimistic trash: the row moves and loses its uid until the server says
    // where it went (Exmail has no UIDPLUS, so it never does).
    moveMessage(id, trash)
    // The next sync finds it in Deleted Messages under a new uid.
    const synced = upsertMessage(mail(trash, 1))
    expect(synced).toBe(id)
    expect(rowsIn(trash)).toEqual([{ id, uid: 1 }])
  })

  it('leaves an unrelated uid-less row alone', () => {
    const id = upsertMessage(mail(inbox, 7))
    moveMessage(id, trash)
    upsertMessage(mail(trash, 2, '<other@x>'))
    expect(rowsIn(trash)).toEqual([
      { id, uid: null },
      { id: expect.any(Number), uid: 2 }
    ])
  })

  it('does not touch local drafts, which have no folder', () => {
    const draft = getDb()
      .prepare(
        "INSERT INTO messages (account_id, folder_id, uid, message_id) VALUES (?, NULL, NULL, '<m1@x>')"
      )
      .run(ACC).lastInsertRowid
    upsertMessage(mail(inbox, 3))
    const d = getDb().prepare('SELECT folder_id, uid FROM messages WHERE id = ?').get(draft)
    expect(d).toEqual({ folder_id: null, uid: null })
  })
})
