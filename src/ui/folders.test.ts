import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { Folder } from '../core/store/types'
import { useStore } from './store'
import { createArchiveFolder, goDoneTarget, reloadFolders } from './folders'

const folder = (id: number, path: string, role: Folder['role']): Folder => ({
  id,
  account_id: 1,
  name: path,
  path,
  uidvalidity: null,
  last_uid: 0,
  role
})

const INBOX = folder(1, 'INBOX', 'inbox')
const ARCHIVE = folder(9, 'Archive', 'archive')

/** Same lookup gotoFolder in App.tsx does for `g e`. */
const findByRole = (role: Folder['role']): Folder | undefined =>
  useStore.getState().folders.find((f) => f.role === role)

describe('folder refresh after Archive is created', () => {
  beforeEach(() => useStore.getState().setFolders([INBOX]))

  it('puts the new Archive folder in the store so g e can find it', async () => {
    const api = {
      createArchive: vi.fn(async () => ({ ok: true as const })),
      listFolders: vi.fn(async () => [INBOX, ARCHIVE])
    }
    expect(findByRole('archive')).toBeUndefined()
    const r = await createArchiveFolder(api)
    expect(r).toEqual({ ok: true })
    expect(api.listFolders).toHaveBeenCalledTimes(1)
    expect(findByRole('archive')?.id).toBe(ARCHIVE.id)
  })

  it('leaves the folder list alone when the server refuses', async () => {
    const api = {
      createArchive: vi.fn(async () => ({ ok: false as const, error: 'NO [ALREADYEXISTS]' })),
      listFolders: vi.fn(async () => [INBOX, ARCHIVE])
    }
    const r = await createArchiveFolder(api)
    expect(r).toEqual({ ok: false, error: 'NO [ALREADYEXISTS]' })
    expect(api.listFolders).not.toHaveBeenCalled()
    expect(useStore.getState().folders).toEqual([INBOX])
  })

  it('reloadFolders replaces the store list with what SQLite has now', async () => {
    await reloadFolders({ listFolders: async () => [INBOX, ARCHIVE] })
    expect(useStore.getState().folders).toEqual([INBOX, ARCHIVE])
  })
})

describe('callers refresh folders', () => {
  const src = (p: string): string => readFileSync(join(__dirname, p), 'utf8')

  it('TriageSettings creates Archive through the refreshing helper', () => {
    const s = src('views/TriageSettings.tsx')
    expect(s).toContain('createArchiveFolder()')
    expect(s).not.toContain('window.api.createArchive(')
  })

  it('backgroundSync reloads folders after a successful sync', () => {
    const s = src('App.tsx')
    const body = s.slice(s.indexOf('const backgroundSync'), s.indexOf('}, [loadRows, setSyncError'))
    expect(body).toContain('await reloadFolders()')
  })
})

describe('TriageSettings Gmail guard', () => {
  const s = readFileSync(join(__dirname, 'views/TriageSettings.tsx'), 'utf8')

  it('shows the reason instead of the Create button when canCreate is false', () => {
    const guard = s.indexOf('!archive.canCreate')
    expect(guard).toBeGreaterThan(-1)
    expect(s.slice(guard, guard + 200)).toContain('archive.reason')
    expect(guard).toBeLessThan(s.indexOf('Create an Archive folder'))
    expect(guard).toBeLessThan(s.indexOf('Create it'))
  })
})

describe('goDoneTarget (g e)', () => {
  it('opens the archive folder on IMAP and Outlook', () => {
    expect(goDoneTarget([INBOX, ARCHIVE], 'imap')).toEqual({ folderId: ARCHIVE.id })
    expect(goDoneTarget([INBOX, ARCHIVE], 'microsoft')).toEqual({ folderId: ARCHIVE.id })
  })

  it('says where Done mail is on Gmail instead of silently doing nothing', () => {
    // folders:list hides All Mail, and no Gmail folder has role archive.
    const t = goDoneTarget([INBOX, ARCHIVE], 'gmail')
    expect(t).toEqual({ message: expect.stringContaining('All Mail') })
  })

  it('points at Settings when the account has no Done folder yet', () => {
    expect(goDoneTarget([INBOX], 'imap')).toEqual({ message: expect.stringContaining('Settings') })
  })
})
