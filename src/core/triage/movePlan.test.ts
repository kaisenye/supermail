import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { moveMessage, upsertMessage } from '../store/repo.js'
import { planMoves } from './movePlan.js'

let uid = 0
const put = (account: number, folder: number, thread: string) =>
  upsertMessage({
    account_id: account, folder_id: folder, uid: ++uid, message_id: `<${uid}@t>`, thread_id: thread,
    in_reply_to: null, from_addr: null, from_name: null, to_addrs: null, cc_addrs: null,
    subject: null, date: uid, snippet: null
  })

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'moveplan-')), 't.db'))
  uid = 0
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email,provider) VALUES (1,'a@x.test','imap'),(2,'b@gmail.com','gmail')").run()
  db.prepare(
    `INSERT INTO folders (id,account_id,path,role,uidvalidity) VALUES
       (1,1,'INBOX','inbox',7),(2,1,'Archive','archive',8),
       (3,2,'INBOX','inbox',9),(4,2,'[Gmail]/All Mail','all',10)`
  ).run()
})

const provider = (id: number) => (id === 2 ? ('gmail' as const) : ('imap' as const))

describe('planMoves', () => {
  it('moves the whole thread in that folder and records where it came from', () => {
    const a = put(1, 1, 't')
    const b = put(1, 1, 't')
    put(1, 2, 't') // already in Archive: not part of the Inbox row
    const r = planMoves([b], { role: 'archive' }, provider)
    expect(r.ok && r.plan.map((p) => [p.id, p.fromPath, p.toPath, p.uidValidity])).toEqual([
      [b, 'INBOX', 'Archive', 7],
      [a, 'INBOX', 'Archive', 7]
    ])
  })

  it('maps Done to All Mail on Gmail', () => {
    const g = put(2, 3, 'g')
    const r = planMoves([g], { role: 'archive' }, provider)
    expect(r.ok && r.plan[0].toPath).toBe('[Gmail]/All Mail')
  })

  it('skips rows already moving or already there', () => {
    const a = put(1, 1, 't')
    moveMessage(a, 2) // optimistic move: uid is now NULL
    const b = put(1, 2, 'u')
    const r = planMoves([a, b], { role: 'archive' }, provider)
    expect(r.ok && r.plan).toEqual([])
  })

  it('fails without touching anything when the account has no such folder', () => {
    getDb().prepare("UPDATE folders SET role = NULL WHERE path = 'Archive'").run()
    expect(planMoves([put(1, 1, 't')], { role: 'archive' }, provider)).toEqual({
      ok: false,
      error: 'no archive folder'
    })
  })
})
