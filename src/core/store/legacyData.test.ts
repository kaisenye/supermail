import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { adoptLegacyData } from './legacyData.js'

function oldFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'old-'))
  const db = new Database(join(dir, 'supermail.db'))
  db.pragma('journal_mode = WAL')
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')")
  // Left open on purpose: the row may still sit only in the WAL, as it would
  // while an older build is running.
  mkdirSync(join(dir, 'attachments', '1'), { recursive: true })
  writeFileSync(join(dir, 'attachments', '1', 'a.pdf'), 'pdf')
  return dir
}

describe('adoptLegacyData', () => {
  it('copies the database (WAL included) and attachments into the new folder', () => {
    const old = oldFolder()
    const neu = join(mkdtempSync(join(tmpdir(), 'new-')), 'Sovo')
    expect(adoptLegacyData(old, neu, 'sovo.db')).toBe(true)
    const db = new Database(join(neu, 'sovo.db'), { readonly: true })
    expect(db.prepare('SELECT v FROM t').get()).toEqual({ v: 'kept' })
    db.close()
    expect(readFileSync(join(neu, 'attachments', '1', 'a.pdf'), 'utf8')).toBe('pdf')
    // The old folder is left as it was, as a backup.
    expect(existsSync(join(old, 'supermail.db'))).toBe(true)
  })

  it('does nothing once the new database exists, or when there is no old one', () => {
    const old = oldFolder()
    const neu = mkdtempSync(join(tmpdir(), 'new-'))
    expect(adoptLegacyData(old, neu, 'sovo.db')).toBe(true)
    expect(adoptLegacyData(old, neu, 'sovo.db')).toBe(false)
    expect(adoptLegacyData(mkdtempSync(join(tmpdir(), 'empty-')), mkdtempSync(join(tmpdir(), 'n-')), 'sovo.db')).toBe(false)
  })
})
