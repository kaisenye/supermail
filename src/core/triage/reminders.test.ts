import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { listView } from '../store/listRows.js'
import { upsertMessage } from '../store/repo.js'
import {
  clearReminder,
  clearReminders,
  dropFiredReminders,
  getReminder,
  listReminderRows,
  reminderOutcome,
  restoreReminders,
  setReminder,
  wakeDueReminders
} from './reminders.js'

const ME = 'me@x.test'
let uid = 0
const put = (folder: number, o: { id: string; thread: string; from: string; date: number }) =>
  upsertMessage({
    account_id: 1,
    folder_id: folder,
    uid: ++uid,
    message_id: o.id,
    thread_id: o.thread,
    in_reply_to: null,
    from_addr: o.from,
    from_name: null,
    to_addrs: '[]',
    cc_addrs: '[]',
    subject: o.thread,
    date: o.date,
    snippet: null,
    flags: '[]'
  })

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'remind-')), 't.db'))
  uid = 0
  getDb().prepare('INSERT INTO accounts (id,email) VALUES (1,?)').run(ME)
  getDb()
    .prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox'),(2,1,'Sent','sent')")
    .run()
})

describe('reminderOutcome', () => {
  const r = { remind_at: 1000, created_at: 100 }
  it('waits until due, then fires', () => {
    expect(reminderOutcome(r, null, 999)).toBe('wait')
    expect(reminderOutcome(r, null, 1000)).toBe('fire')
  })
  it('drops once someone replied after it was set', () => {
    expect(reminderOutcome(r, 150, 500)).toBe('drop')
    expect(reminderOutcome(r, 50, 1000)).toBe('fire')
  })
})

describe('reminders', () => {
  it('hide the thread from the Inbox while pending, and bump it when fired', () => {
    put(1, { id: '<a@t>', thread: 'a', from: 'x@y.test', date: 100 })
    put(1, { id: '<b@t>', thread: 'b', from: 'x@y.test', date: 200 })
    setReminder({ accountId: 1, messageId: '<a@t>', subject: 'a', remindAt: 5000, ifNoReply: false, now: 1000 })
    expect(listView(1).map((r) => r.subject)).toEqual(['b'])
    expect(listReminderRows(1).map((r) => [r.subject, r.remind_at])).toEqual([['a', 5000]])

    expect(wakeDueReminders(4999)).toEqual([])
    expect(wakeDueReminders(5000)).toEqual([{ accountId: 1, subject: 'a' }])
    const rows = listView(1)
    expect(rows.map((r) => [r.subject, r.reminder_fired])).toEqual([
      ['a', 1],
      ['b', 0]
    ])
  })

  it('come back early when a reply arrives, and are dropped at wake', () => {
    put(2, { id: '<s@t>', thread: 's', from: ME, date: 100 })
    setReminder({ accountId: 1, messageId: '<s@t>', subject: 's', remindAt: 5000, ifNoReply: true, now: 1000 })
    put(1, { id: '<r@t>', thread: 's', from: 'x@y.test', date: 2000 })
    expect(listView(1).map((r) => r.subject)).toEqual(['s'])
    expect(wakeDueReminders(6000)).toEqual([])
    expect(listReminderRows(1)).toEqual([])
  })

  it('ignore mail already in the thread, even when its Date is ahead of the local clock', () => {
    put(1, { id: '<a@t>', thread: 'a', from: 'x@y.test', date: 1120 })
    setReminder({ accountId: 1, messageId: '<a@t>', subject: 'a', remindAt: 5000, ifNoReply: true, now: 1000 })
    expect(getReminder(1, '<a@t>')?.created_at).toBe(1120)
    expect(listView(1)).toEqual([])
    expect(wakeDueReminders(6000)).toEqual([{ accountId: 1, subject: 'a' }])
    expect(listReminderRows(1).map((r) => [r.subject, r.reminder_fired])).toEqual([['a', 1]])
  })

  it('are still ended by a reply newer than the future-dated message', () => {
    put(1, { id: '<a@t>', thread: 'a', from: 'x@y.test', date: 1120 })
    setReminder({ accountId: 1, messageId: '<a@t>', subject: 'a', remindAt: 5000, ifNoReply: true, now: 1000 })
    put(1, { id: '<r@t>', thread: 'a', from: 'z@y.test', date: 1500 })
    expect(listView(1).map((r) => r.subject)).toEqual(['a'])
    expect(wakeDueReminders(6000)).toEqual([])
    expect(listReminderRows(1)).toEqual([])
  })

  it('never hide anything outside the Inbox', () => {
    put(2, { id: '<s@t>', thread: 's', from: ME, date: 100 })
    setReminder({ accountId: 1, messageId: '<s@t>', subject: 's', remindAt: 5000, ifNoReply: true, now: 1000 })
    expect(listView(2).map((r) => r.subject)).toEqual(['s'])
  })

  it('are not ended by a junked message or a draft', () => {
    getDb().prepare("INSERT INTO folders (id,account_id,path,role) VALUES (3,1,'Junk','junk')").run()
    put(1, { id: '<a@t>', thread: 'a', from: 'x@y.test', date: 100 })
    setReminder({ accountId: 1, messageId: '<a@t>', subject: 'a', remindAt: 5000, ifNoReply: false, now: 1000 })
    put(3, { id: '<j@t>', thread: 'a', from: 'spam@y.test', date: 2000 })
    expect(listView(1)).toEqual([])
    expect(wakeDueReminders(5000)).toEqual([{ accountId: 1, subject: 'a' }])
  })

  it('can be cleared', () => {
    put(1, { id: '<a@t>', thread: 'a', from: 'x@y.test', date: 100 })
    setReminder({ accountId: 1, messageId: '<a@t>', subject: 'a', remindAt: 5000, ifNoReply: false, now: 1000 })
    expect(clearReminder(1, '<a@t>')).toBe(true)
    expect(listView(1).map((r) => r.subject)).toEqual(['a'])
  })

  it('report what a reschedule replaced, and undo puts the old time back', () => {
    put(1, { id: '<a@t>', thread: 'a', from: 'x@y.test', date: 100 })
    expect(
      setReminder({ accountId: 1, messageId: '<a@t>', subject: 'a', remindAt: 5000, ifNoReply: false, now: 1000 })
    ).toBeNull()
    const prev = setReminder({
      accountId: 1,
      messageId: '<a@t>',
      subject: 'a',
      remindAt: 9000,
      ifNoReply: true,
      now: 2000
    })
    expect(prev).toMatchObject({ remind_at: 5000, if_no_reply: 0, created_at: 1000, fired_at: null })
    restoreReminders([prev!])
    expect(getReminder(1, '<a@t>')).toMatchObject({ remind_at: 5000, if_no_reply: 0, created_at: 1000 })
    expect(listReminderRows(1).map((r) => r.remind_at)).toEqual([5000])
  })

  it('undo of rescheduling a fired reminder brings it back fired, at the top of the Inbox', () => {
    put(1, { id: '<a@t>', thread: 'a', from: 'x@y.test', date: 100 })
    put(1, { id: '<b@t>', thread: 'b', from: 'x@y.test', date: 200 })
    setReminder({ accountId: 1, messageId: '<a@t>', subject: 'a', remindAt: 5000, ifNoReply: false, now: 1000 })
    wakeDueReminders(5000)
    const prev = setReminder({ accountId: 1, messageId: '<a@t>', subject: 'a', remindAt: 9000, ifNoReply: false, now: 6000 })
    expect(prev?.fired_at).toBe(5000)
    expect(listView(1).map((r) => r.subject)).toEqual(['b'])
    restoreReminders([prev!])
    expect(listView(1).map((r) => [r.subject, r.reminder_fired])).toEqual([
      ['a', 1],
      ['b', 0]
    ])
  })

  it('fired on a Sent message are dropped when the Inbox side of the thread is moved', () => {
    put(1, { id: '<q@t>', thread: 's', from: 'x@y.test', date: 50 })
    const sent = put(2, { id: '<s@t>', thread: 's', from: ME, date: 100 })
    setReminder({ accountId: 1, messageId: '<s@t>', subject: 's', remindAt: 5000, ifNoReply: true, now: 1000 })
    expect(wakeDueReminders(5000)).toEqual([{ accountId: 1, subject: 's' }])
    expect(listView(1).map((r) => r.reminder_fired)).toEqual([1])
    const inboxId = getDb().prepare("SELECT id FROM messages WHERE message_id = '<q@t>'").get() as {
      id: number
    }
    expect(inboxId.id).not.toBe(sent)
    dropFiredReminders([inboxId.id])
    expect(listReminderRows(1)).toEqual([])
    expect(listView(1).map((r) => r.reminder_fired)).toEqual([0])
    expect(listView(2).map((r) => r.reminder_fired)).toEqual([0])
  })

  it('pending are not dropped by a move, and other threads are untouched', () => {
    put(1, { id: '<a@t>', thread: 'a', from: 'x@y.test', date: 100 })
    put(1, { id: '<b@t>', thread: 'b', from: 'x@y.test', date: 100 })
    setReminder({ accountId: 1, messageId: '<a@t>', subject: 'a', remindAt: 5000, ifNoReply: false, now: 1000 })
    setReminder({ accountId: 1, messageId: '<b@t>', subject: 'b', remindAt: 3000, ifNoReply: false, now: 1000 })
    wakeDueReminders(3000)
    const ids = getDb().prepare('SELECT id FROM messages ORDER BY id').all() as { id: number }[]
    dropFiredReminders([ids[0].id])
    expect(listReminderRows(1).map((r) => r.subject).sort()).toEqual(['a', 'b'])
  })

  // Known gap (plan): the read model is per folder, so a thread with no Inbox
  // row does not come back to the Inbox; it shows as fired in g h.
  it('fired on a Sent-only thread show in the Reminders view, not the Inbox', () => {
    put(2, { id: '<s@t>', thread: 's', from: ME, date: 100 })
    setReminder({ accountId: 1, messageId: '<s@t>', subject: 's', remindAt: 5000, ifNoReply: true, now: 1000 })
    wakeDueReminders(5000)
    expect(listView(1)).toEqual([])
    expect(listReminderRows(1).map((r) => [r.subject, r.reminder_fired])).toEqual([['s', 1]])
  })
})

describe('reminders for undo', () => {
  it('clearReminders returns what it cleared, once per message, and restore brings it back', () => {
    put(2, { id: '<s@t>', thread: 's', from: ME, date: 100 })
    setReminder({ accountId: 1, messageId: '<s@t>', subject: 's', remindAt: 5000, ifNoReply: true, now: 1000 })
    const before = getReminder(1, '<s@t>')
    const cleared = clearReminders([
      { account_id: 1, message_id: '<s@t>' },
      { account_id: 1, message_id: '<s@t>' },
      { account_id: 1, message_id: '<none@t>' }
    ])
    expect(cleared).toEqual([before])
    expect(getReminder(1, '<s@t>')).toBeNull()
    restoreReminders(cleared)
    expect(getReminder(1, '<s@t>')).toEqual(before)
  })

  it('dropFiredReminders returns the fired reminders it dropped, and skips pending ones', () => {
    put(1, { id: '<a@t>', thread: 'a', from: 'x@y.test', date: 100 })
    put(1, { id: '<b@t>', thread: 'b', from: 'x@y.test', date: 100 })
    setReminder({ accountId: 1, messageId: '<a@t>', subject: 'a', remindAt: 50, ifNoReply: false, now: 20 })
    setReminder({ accountId: 1, messageId: '<b@t>', subject: 'b', remindAt: 9999, ifNoReply: false, now: 20 })
    wakeDueReminders(60)
    const fired = getReminder(1, '<a@t>')
    const ids = listView(1).map((r) => r.id)
    expect(dropFiredReminders(ids)).toEqual([fired])
    expect(getReminder(1, '<b@t>')).not.toBeNull()
  })

  it('listView returns the sort key, which a fired reminder bumps', () => {
    put(1, { id: '<a@t>', thread: 'a', from: 'x@y.test', date: 100 })
    setReminder({ accountId: 1, messageId: '<a@t>', subject: 'a', remindAt: 5000, ifNoReply: false, now: 1000 })
    wakeDueReminders(5000)
    const [row] = listView(1)
    expect([row.date, row.sort_date]).toEqual([100, 5000])
  })
})
