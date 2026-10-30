import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { moveMessage, upsertMessage } from '../store/repo.js'
import { planMoves } from './movePlan.js'
import { rollbackMoves } from './moveUndo.js'
import { dropFiredReminders, getReminder, setReminder, wakeDueReminders } from './reminders.js'

const put = (folder: number, uid: number, id: string, thread: string) =>
  upsertMessage({
    account_id: 1, folder_id: folder, uid, message_id: id, thread_id: thread,
    in_reply_to: null, from_addr: 'x@y.test', from_name: null, to_addrs: null, cc_addrs: null,
    subject: thread, date: uid, snippet: null, flags: '[]'
  })

const loc = (id: number) =>
  getDb().prepare('SELECT folder_id, uid FROM messages WHERE id = ?').get(id) as { folder_id: number; uid: number | null }

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'moveundo-')), 't.db'))
  getDb().prepare("INSERT INTO accounts (id,email,provider) VALUES (1,'me@x.test','imap')").run()
  getDb()
    .prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox'),(2,1,'Archive','archive')")
    .run()
})

/** What holdMove does: plan, drop fired reminders, move locally. */
function hold(ids: number[]) {
  const r = planMoves(ids, { role: 'archive' }, () => 'imap')
  if (!r.ok) throw new Error(r.error)
  const reminders = dropFiredReminders(r.plan.map((p) => p.id))
  for (const p of r.plan) moveMessage(p.id, p.toFolderId)
  return { jobs: r.plan, reminders }
}

describe('rollbackMoves', () => {
  it('puts a fired reminder back when the move is undone', () => {
    const a = put(1, 10, '<a@t>', 'a')
    setReminder({ accountId: 1, messageId: '<a@t>', subject: 'a', remindAt: 50, ifNoReply: false, now: 20 })
    wakeDueReminders(60)
    const before = getReminder(1, '<a@t>')
    expect(before?.fired_at).toBe(60)

    const batch = hold([a])
    expect(getReminder(1, '<a@t>')).toBeNull()
    expect(batch.reminders).toEqual([before])

    rollbackMoves(batch.jobs, batch.reminders)
    expect(loc(a)).toEqual({ folder_id: 1, uid: 10 })
    expect(getReminder(1, '<a@t>')).toEqual(before)
  })

  it('deletes a copy backfill re-inserted at the source uid, then restores the original', () => {
    const a = put(1, 10, '<a@t>', 'a')
    const batch = hold([a])
    // Backfill during the hold: the server still has uid 10 in INBOX.
    const dupe = put(1, 10, '<a@t>', 'a')
    expect(dupe).not.toBe(a)

    rollbackMoves(batch.jobs, batch.reminders)
    expect(loc(a)).toEqual({ folder_id: 1, uid: 10 })
    expect(getDb().prepare('SELECT count(*) c FROM messages WHERE folder_id = 1').get()).toEqual({ c: 1 })
  })

  it('changes nothing when any part fails, so the batch can still commit', () => {
    const a = put(1, 10, '<a@t>', 'a')
    const b = put(1, 11, '<b@t>', 'b')
    const batch = hold([a, b])
    // A reminder for an account that does not exist fails the FK at the end.
    const bad = { account_id: 99, message_id: '<x@t>', subject: null, remind_at: 1, if_no_reply: 0, created_at: 1, fired_at: 1 }
    expect(() => rollbackMoves(batch.jobs, [bad])).toThrow()
    expect(loc(a)).toEqual({ folder_id: 2, uid: null })
    expect(loc(b)).toEqual({ folder_id: 2, uid: null })
  })
})
