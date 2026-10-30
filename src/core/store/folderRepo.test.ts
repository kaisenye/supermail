import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import {
  folderByRole,
  getFolder,
  resetFolder,
  setFolderRole,
  setFolderRoles,
  setHistoryComplete,
  threadMatesInFolder,
  upsertFolder,
  upsertMessage
} from './repo.js'

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'folders-')), 't.db'))
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (1,'a@b.test'),(2,'c@d.test')").run()
})

const folder = (account_id: number, path: string) =>
  upsertFolder({ account_id, name: path, path, uidvalidity: null })

describe('folder roles', () => {
  it('looks a folder up by role, per account', () => {
    folder(1, 'Sent Messages')
    folder(2, '[Gmail]/Sent Mail')
    setFolderRoles(1, new Map([['Sent Messages', 'sent']]))
    setFolderRoles(2, new Map([['[Gmail]/Sent Mail', 'sent']]))
    expect(folderByRole(1, 'sent')?.path).toBe('Sent Messages')
    expect(folderByRole(2, 'sent')?.path).toBe('[Gmail]/Sent Mail')
    expect(folderByRole(1, 'archive')).toBeUndefined()
  })

  it('moves a role between folders without tripping the unique index', () => {
    const a = folder(1, 'Sent')
    folder(1, 'Sent Messages')
    setFolderRoles(1, new Map([['Sent', 'sent']]))
    setFolderRoles(1, new Map([['Sent Messages', 'sent']]))
    expect(folderByRole(1, 'sent')?.path).toBe('Sent Messages')
    expect(getFolder(a.id)?.role).toBeNull()
  })

  it('reads one folder by id', () => {
    const f = folder(1, 'INBOX')
    expect(getFolder(f.id)?.path).toBe('INBOX')
    expect(getFolder(9999)).toBeUndefined()
  })
})

describe('setFolderRole', () => {
  it('gives a free role to one folder and never steals a taken one', () => {
    const db = getDb()
    db.prepare("INSERT OR IGNORE INTO accounts (id,email) VALUES (9,'r@x.test')").run()
    upsertFolder({ account_id: 9, name: 'Archive', path: 'Archive', uidvalidity: null })
    upsertFolder({ account_id: 9, name: 'Old', path: 'Old', uidvalidity: null })
    expect(setFolderRole(9, 'Archive', 'archive')).toBe(true)
    expect(setFolderRole(9, 'Old', 'archive')).toBe(false)
    expect(folderByRole(9, 'archive')?.path).toBe('Archive')
  })
})

describe('threadMatesInFolder', () => {
  it('returns the row first, then its thread in the same folder only', () => {
    const db = getDb()
    db.prepare("INSERT OR IGNORE INTO accounts (id,email) VALUES (8,'t@x.test')").run()
    const a = upsertFolder({ account_id: 8, name: 'A', path: 'A', uidvalidity: null }).id
    const b = upsertFolder({ account_id: 8, name: 'B', path: 'B', uidvalidity: null }).id
    const put = (folder: number, uid: number, thread: string | null) =>
      upsertMessage({
        account_id: 8, folder_id: folder, uid, message_id: `<${uid}@t>`, thread_id: thread,
        in_reply_to: null, from_addr: null, from_name: null, to_addrs: null, cc_addrs: null,
        subject: null, date: uid, snippet: null
      })
    const x1 = put(a, 1, 't')
    const x2 = put(a, 2, 't')
    put(b, 3, 't')
    const lone = put(a, 4, null)
    expect(threadMatesInFolder(x2)).toEqual([x2, x1])
    expect(threadMatesInFolder(lone)).toEqual([lone])
    expect(threadMatesInFolder(99999)).toEqual([])
  })
})

describe('history_complete', () => {
  it('is set by setHistoryComplete and cleared when the folder is renumbered', () => {
    const { id } = folder(1, 'INBOX')
    resetFolder(id, 5)
    expect(getFolder(id)?.history_complete).toBe(0)
    setHistoryComplete(id, 5)
    expect(getFolder(id)?.history_complete).toBe(1)
    resetFolder(id, 999)
    expect(getFolder(id)?.history_complete).toBe(0)
  })

  it('ignores a completion read before the folder was renumbered', () => {
    const { id } = folder(1, 'INBOX')
    resetFolder(id, 5)
    // A backfill read uidvalidity 5; a forward sync renumbered the folder mid-page.
    resetFolder(id, 6)
    setHistoryComplete(id, 5)
    expect(getFolder(id)?.history_complete).toBe(0)
    setHistoryComplete(id, 6)
    expect(getFolder(id)?.history_complete).toBe(1)
  })
})
