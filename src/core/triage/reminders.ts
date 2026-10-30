import { getDb } from '../store/db.js'
import { markDirtyByMessageId } from '../store/listRows.js'
import { LIST_COLS } from '../store/repo.js'
import type { MessageListRow } from '../store/types.js'

/**
 * Remind me, local only. A reminder is keyed by account + Message-ID; the list
 * read model hides its thread from the Inbox while pending (listRows.ts), and
 * nothing is ever moved on the server.
 */
export interface ReminderRow {
  id: number
  account_id: number
  message_id: string
  subject: string | null
  remind_at: number
  if_no_reply: number
  created_at: number
  fired_at: number | null
}

/** A reminder as stored, without its row id: what undo needs to put it back. */
export type ReminderSnapshot = Omit<ReminderRow, 'id'>

export function getReminder(accountId: number, messageId: string): ReminderSnapshot | null {
  return (
    (getDb()
      .prepare(
        `SELECT account_id, message_id, subject, remind_at, if_no_reply, created_at, fired_at
           FROM reminders WHERE account_id = ? AND message_id = ?`
      )
      .get(accountId, messageId) as ReminderSnapshot | undefined) ?? null
  )
}

/** Sets or reschedules. Returns the reminder it replaced (null if none), for undo. */
export function setReminder(input: {
  accountId: number
  messageId: string
  subject: string | null
  remindAt: number
  ifNoReply: boolean
  now?: number
}): ReminderSnapshot | null {
  const prev = getReminder(input.accountId, input.messageId)
  // The baseline for "a reply came in" is at least the newest inbound mail
  // already in the thread: Date headers are sender-controlled and can be ahead
  // of the local clock, and mail that was there before `h` is not a reply.
  const base = Math.max(input.now ?? Date.now(), lastReplyAt(input.accountId, input.messageId) ?? 0)
  getDb()
    .prepare(
      `INSERT INTO reminders (account_id, message_id, subject, remind_at, if_no_reply, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, message_id) DO UPDATE SET
         subject = excluded.subject, remind_at = excluded.remind_at,
         if_no_reply = excluded.if_no_reply, created_at = excluded.created_at, fired_at = NULL`
    )
    .run(
      input.accountId,
      input.messageId,
      input.subject,
      input.remindAt,
      input.ifNoReply ? 1 : 0,
      base
    )
  markDirtyByMessageId(input.accountId, input.messageId)
  return prev
}

/** Puts reminders back exactly as they were (undo of a reschedule or a dismiss). */
export function restoreReminders(rows: ReminderSnapshot[]): void {
  const db = getDb()
  const upsert = db.prepare(
    `INSERT INTO reminders (account_id, message_id, subject, remind_at, if_no_reply, created_at, fired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, message_id) DO UPDATE SET
       subject = excluded.subject, remind_at = excluded.remind_at,
       if_no_reply = excluded.if_no_reply, created_at = excluded.created_at,
       fired_at = excluded.fired_at`
  )
  db.transaction(() => {
    for (const r of rows) {
      upsert.run(
        r.account_id,
        r.message_id,
        r.subject,
        r.remind_at,
        r.if_no_reply,
        r.created_at,
        r.fired_at
      )
      markDirtyByMessageId(r.account_id, r.message_id)
    }
  })()
}

export function clearReminder(accountId: number, messageId: string): boolean {
  const n = getDb()
    .prepare('DELETE FROM reminders WHERE account_id = ? AND message_id = ?')
    .run(accountId, messageId).changes
  markDirtyByMessageId(accountId, messageId)
  return n > 0
}

/**
 * Clears the reminders keyed to these messages (Done in the Reminders view).
 * Returns them as they were, deduped, so undo can restoreReminders them.
 */
export function clearReminders(
  messages: { account_id: number; message_id: string | null }[]
): ReminderSnapshot[] {
  const cleared: ReminderSnapshot[] = []
  const seen = new Set<string>()
  for (const m of messages) {
    if (!m.message_id) continue
    const key = `${m.account_id}:${m.message_id}`
    if (seen.has(key)) continue
    seen.add(key)
    const before = getReminder(m.account_id, m.message_id)
    if (before && clearReminder(m.account_id, m.message_id)) cleared.push(before)
  }
  return cleared
}

/**
 * A fired reminder has done its job once its thread is acted on (moved). The
 * reminder is keyed to one message (for remind-on-send, the Sent copy) that the
 * move may not touch, so this drops by thread: every fired reminder on any
 * message of the moved messages' threads. Returns what it dropped, so undoing
 * the move can put the reminders back (restoreReminders).
 */
export function dropFiredReminders(messageRowIds: number[]): ReminderSnapshot[] {
  const db = getDb()
  const threads = new Map<string, { accountId: number; key: string }>()
  const lookup = db.prepare(
    "SELECT account_id, COALESCE(thread_id, '#' || id) AS k FROM messages WHERE id = ?"
  )
  for (const id of messageRowIds) {
    const m = lookup.get(id) as { account_id: number; k: string } | undefined
    if (m) threads.set(`${m.account_id}:${m.k}`, { accountId: m.account_id, key: m.k })
  }
  const match = `account_id = ? AND fired_at IS NOT NULL AND message_id IN (
        SELECT message_id FROM messages
         WHERE account_id = ? AND message_id IS NOT NULL
           AND COALESCE(thread_id, '#' || id) = ?)`
  const select = db.prepare(
    `SELECT account_id, message_id, subject, remind_at, if_no_reply, created_at, fired_at
       FROM reminders WHERE ${match}`
  )
  const drop = db.prepare(`DELETE FROM reminders WHERE ${match}`)
  const dirty = db.prepare('INSERT OR IGNORE INTO list_dirty (account_id, thread_key) VALUES (?, ?)')
  const dropped: ReminderSnapshot[] = []
  for (const { accountId, key } of threads.values()) {
    dropped.push(...(select.all(accountId, accountId, key) as ReminderSnapshot[]))
    if (drop.run(accountId, accountId, key).changes) dirty.run(accountId, key)
  }
  return dropped
}

export type ReminderOutcome = 'wait' | 'fire' | 'drop'

/**
 * Any reply after the reminder was set ends it: for "if no reply" that is the
 * point, and a plain reminder's thread is already back in the Inbox.
 */
export function reminderOutcome(
  r: Pick<ReminderRow, 'remind_at' | 'created_at'>,
  lastReplyAt: number | null,
  now: number
): ReminderOutcome {
  if (lastReplyAt !== null && lastReplyAt > r.created_at) return 'drop'
  return now >= r.remind_at ? 'fire' : 'wait'
}

/**
 * Newest message from someone else in the thread(s) holding `messageId`.
 * Drafts, Trash and Junk are not replies, matching the read model's last_inbound.
 */
export function lastReplyAt(accountId: number, messageId: string): number | null {
  const row = getDb()
    .prepare(
      `WITH th AS (
         SELECT DISTINCT COALESCE(thread_id, '#' || id) AS k FROM messages
          WHERE account_id = ? AND message_id = ?
       )
       SELECT MAX(m.date) AS d FROM messages m JOIN th
           ON (m.thread_id = th.k OR (m.thread_id IS NULL AND '#' || m.id = th.k))
         JOIN accounts a ON a.id = m.account_id
         LEFT JOIN folders f ON f.id = m.folder_id
        WHERE m.account_id = ? AND m.folder_id IS NOT NULL
          AND COALESCE(f.role, '') NOT IN ('drafts', 'trash', 'junk')
          AND lower(COALESCE(m.from_addr, '')) <> lower(a.email)`
    )
    .get(accountId, messageId, accountId) as { d: number | null }
  return row.d
}

/** Fires or drops every due reminder. Returns the ones that fired, for a notification. */
export function wakeDueReminders(now = Date.now()): { accountId: number; subject: string | null }[] {
  const db = getDb()
  const due = db
    .prepare('SELECT * FROM reminders WHERE fired_at IS NULL AND remind_at <= ?')
    .all(now) as ReminderRow[]
  const fired: { accountId: number; subject: string | null }[] = []
  for (const r of due) {
    const outcome = reminderOutcome(r, lastReplyAt(r.account_id, r.message_id), now)
    if (outcome === 'drop') db.prepare('DELETE FROM reminders WHERE id = ?').run(r.id)
    else if (outcome === 'fire') {
      db.prepare('UPDATE reminders SET fired_at = ? WHERE id = ?').run(now, r.id)
      fired.push({ accountId: r.account_id, subject: r.subject })
    }
    markDirtyByMessageId(r.account_id, r.message_id)
  }
  return fired
}

const M_COLS = LIST_COLS.split(', ')
  .map((c) => `m.${c}`)
  .join(', ')

/** The Reminders view: pending first by due time, then fired. Unsynced messages are skipped. */
export function listReminderRows(accountId: number): MessageListRow[] {
  return getDb()
    .prepare(
      `SELECT ${M_COLS}, r.remind_at AS remind_at,
              CASE WHEN r.fired_at IS NULL THEN 0 ELSE 1 END AS reminder_fired
         FROM reminders r
         JOIN messages m ON m.id = (
           SELECT x.id FROM messages x
            WHERE x.account_id = r.account_id AND x.message_id = r.message_id
            ORDER BY x.folder_id IS NULL, x.id LIMIT 1)
        WHERE r.account_id = ?
        ORDER BY r.fired_at IS NOT NULL, r.remind_at`
    )
    .all(accountId) as MessageListRow[]
}
