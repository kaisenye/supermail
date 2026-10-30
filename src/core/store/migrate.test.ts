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

describe('migration v18 (triage)', () => {
  it('adds list headers, the read model and local triage tables, with backfills', () => {
    const db = new Database(join(mkdtempSync(join(tmpdir(), 'migrate-')), 't.db'))
    db.pragma('foreign_keys = ON')
    migrate(db, 17)
    db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
    db.prepare(
      "INSERT INTO folders (id,account_id,name,path,role) VALUES (1,1,'INBOX','INBOX','inbox'),(2,1,'Sent','Sent','sent')"
    ).run()
    const ins = db.prepare(
      `INSERT INTO messages (account_id, folder_id, uid, message_id, thread_id, from_addr, to_addrs, cc_addrs, date, flags)
       VALUES (1, ?, ?, ?, ?, ?, ?, '[]', ?, '[]')`
    )
    ins.run(1, 1, '<a@x>', '<a@x>', 'friend@x.test', '[{"address":"me@x.test","name":null}]', 100)
    ins.run(2, 1, '<b@x>', '<a@x>', 'ME@x.test', '[{"address":"Friend@x.test","name":null}]', 200)
    ins.run(1, 2, '<c@x>', null, 'other@x.test', '[]', 300)

    expect(migrate(db)).toBeGreaterThanOrEqual(18)

    const cols = (t: string) =>
      (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('messages')).toEqual(
      expect.arrayContaining(['list_unsubscribe', 'unsubscribe_one_click', 'bulk'])
    )
    expect(cols('outbox')).toContain('remind_at')
    expect(cols('labels')).toContain('account_id')
    for (const t of [
      'list_rows',
      'list_dirty',
      'reminders',
      'mutes',
      'vip_senders',
      'replied_senders',
      'splits'
    ])
      expect(cols(t).length).toBeGreaterThan(0)

    // Every synced thread starts dirty, so the first list read builds it.
    const dirty = db.prepare('SELECT thread_key FROM list_dirty ORDER BY thread_key').all()
    expect(dirty).toEqual([{ thread_key: '#3' }, { thread_key: '<a@x>' }])

    // Mail I sent marks its recipients as people I reply to (case-folded).
    expect(db.prepare('SELECT address FROM replied_senders').all()).toEqual([
      { address: 'friend@x.test' }
    ])

    // New writes keep list_dirty current.
    db.prepare('DELETE FROM list_dirty').run()
    db.prepare("UPDATE messages SET flags = '[\"\\\\Seen\"]' WHERE uid = 1 AND folder_id = 1").run()
    expect(db.prepare('SELECT thread_key FROM list_dirty').all()).toEqual([{ thread_key: '<a@x>' }])
    db.close()
  })
})

describe('migration v20 (phase 3)', () => {
  it('adds cancel_on_reply, history_complete, snippets and a task index that stays current', () => {
    const db = new Database(join(mkdtempSync(join(tmpdir(), 'migrate-')), 't.db'))
    db.pragma('foreign_keys = ON')
    migrate(db, 19)
    db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
    db.prepare(
      `INSERT INTO tasks (account_id,title,description,created_at,updated_at,sort_order)
       VALUES (1,'Call the bank','about the loan',1,1,0)`
    ).run()

    expect(migrate(db)).toBeGreaterThanOrEqual(20)

    const cols = (t: string) =>
      (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('outbox')).toContain('cancel_on_reply')
    expect(cols('folders')).toContain('history_complete')
    expect(cols('snippets')).toEqual(
      expect.arrayContaining(['id', 'name', 'shortcut', 'body', 'created_at', 'updated_at'])
    )

    const hit = (q: string) => db.prepare('SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH ?').all(q)
    // Existing tasks are indexed, and the index follows updates and deletes.
    expect(hit('bank')).toEqual([{ rowid: 1 }])
    db.prepare("UPDATE tasks SET title = 'Call the insurer' WHERE id = 1").run()
    expect(hit('bank')).toEqual([])
    expect(hit('insurer')).toEqual([{ rowid: 1 }])
    db.prepare('DELETE FROM tasks WHERE id = 1').run()
    expect(hit('insurer')).toEqual([])

    // Snippet shortcuts are unique, ignoring case; a snippet may have none.
    const ins = db.prepare(
      'INSERT INTO snippets (name, shortcut, body, created_at, updated_at) VALUES (?, ?, ?, 1, 1)'
    )
    ins.run('Thanks', 'thx', 'Thanks!')
    expect(() => ins.run('Again', 'THX', 'x')).toThrow()
    ins.run('No key 1', null, 'a')
    ins.run('No key 2', null, 'b')
    db.close()
  })
})
