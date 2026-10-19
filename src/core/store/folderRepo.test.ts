import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import { folderByRole, getFolder, setFolderRoles, upsertFolder } from './repo.js'

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
