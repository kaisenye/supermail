import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrate } from './migrate.js'

describe('migration v14 (folder roles)', () => {
  it('backfills roles from names on existing folders', () => {
    const db = new Database(join(mkdtempSync(join(tmpdir(), 'migrate-')), 't.db'))
    db.pragma('foreign_keys = ON')
    migrate(db, 13)
    db.prepare("INSERT INTO accounts (id,email) VALUES (1,'a@b.test'),(2,'c@d.test')").run()
    const ins = db.prepare('INSERT INTO folders (account_id,name,path) VALUES (?,?,?)')
    for (const p of ['INBOX', 'Sent Messages', 'Deleted Messages', 'Trash', 'Junk', '客户'])
      ins.run(1, p, p)
    for (const p of ['INBOX', 'Sent']) ins.run(2, p, p)

    const version = migrate(db)
    expect(version).toBeGreaterThanOrEqual(14)

    const roles = (account: number) =>
      Object.fromEntries(
        (
          db.prepare('SELECT path, role FROM folders WHERE account_id = ?').all(account) as {
            path: string
            role: string | null
          }[]
        ).map((r) => [r.path, r.role])
      )
    expect(roles(1)).toEqual({
      INBOX: 'inbox',
      'Sent Messages': 'sent',
      'Deleted Messages': 'trash',
      Trash: null,
      Junk: 'junk',
      客户: null
    })
    expect(roles(2)).toEqual({ INBOX: 'inbox', Sent: 'sent' })

    expect(() =>
      db.prepare("INSERT INTO folders (account_id,name,path,role) VALUES (1,'X','X','sent')").run()
    ).toThrow()
    db.close()
  })
})
