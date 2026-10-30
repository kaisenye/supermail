import { getDb } from '../store/db.js'

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled'

export interface OutboxRow {
  id: number
  account_id: number
  draft_message_id: number | null
  to_addrs: string
  cc_addrs: string | null
  bcc_addrs: string | null
  subject: string | null
  body_text: string | null
  body_html: string | null
  in_reply_to: string | null
  references_header: string | null
  attachments: string | null
  send_at: number
  /** "Remind me if no reply" chosen in compose; the reminder is saved after the send. */
  remind_at: number | null
  /** 1: cancel this scheduled send if someone replies to its thread first. */
  cancel_on_reply: number
  status: OutboxStatus
  error: string | null
  created_at: number
}

export interface EnqueueOutboxInput {
  account_id: number
  draft_message_id: number | null
  to_addrs: string
  cc_addrs?: string | null
  bcc_addrs?: string | null
  subject?: string | null
  body_text?: string | null
  body_html?: string | null
  in_reply_to?: string | null
  references_header?: string | null
  attachments?: string | null
  send_at: number
  remind_at?: number | null
  cancel_on_reply?: number
}

/**
 * A "remind me if no reply" time must come after the send itself: a reminder
 * due before the mail goes out would fire as soon as it is sent.
 */
export function remindAtError(remindAt: number | null | undefined, sendAt: number): string | null {
  if (remindAt == null) return null
  return remindAt <= sendAt ? 'Reminder must be later than the send time' : null
}

/**
 * When to save the reminder for a row sent at `now`. A send that went out late
 * (a retry after a failure, or the app was closed) keeps the gap the user chose
 * between send and reminder. Null when the reminder would already be due.
 */
export function reminderTimeAfterSend(
  row: Pick<OutboxRow, 'send_at' | 'remind_at'>,
  now: number
): number | null {
  if (row.remind_at == null) return null
  if (row.remind_at > now) return row.remind_at
  const shifted = row.remind_at + Math.max(0, now - row.send_at)
  return shifted > now ? shifted : null
}

export function enqueueOutbox(input: EnqueueOutboxInput): OutboxRow {
  const db = getDb()
  const created_at = Date.now()
  const info = db
    .prepare(
      `INSERT INTO outbox (
         account_id, draft_message_id, to_addrs, cc_addrs, bcc_addrs,
         subject, body_text, body_html, in_reply_to, references_header,
         attachments, send_at, remind_at, cancel_on_reply, status, created_at
       ) VALUES (
         @account_id, @draft_message_id, @to_addrs, @cc_addrs, @bcc_addrs,
         @subject, @body_text, @body_html, @in_reply_to, @references_header,
         @attachments, @send_at, @remind_at, @cancel_on_reply, 'pending', @created_at
       )`
    )
    .run({
      account_id: input.account_id,
      draft_message_id: input.draft_message_id,
      to_addrs: input.to_addrs,
      cc_addrs: input.cc_addrs ?? null,
      bcc_addrs: input.bcc_addrs ?? null,
      subject: input.subject ?? null,
      body_text: input.body_text ?? null,
      body_html: input.body_html ?? null,
      in_reply_to: input.in_reply_to ?? null,
      references_header: input.references_header ?? null,
      attachments: input.attachments ?? null,
      send_at: input.send_at,
      remind_at: input.remind_at ?? null,
      cancel_on_reply: input.cancel_on_reply ?? 0,
      created_at
    })
  return getOutbox(Number(info.lastInsertRowid))!
}

export function getOutbox(id: number): OutboxRow | undefined {
  return getDb().prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxRow | undefined
}

export function cancelOutbox(id: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE outbox SET status = 'cancelled'
       WHERE id = ? AND status = 'pending'`
    )
    .run(id)
  return info.changes > 0
}

export function listPendingOutbox(accountId: number): OutboxRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM outbox
       WHERE account_id = ? AND status = 'pending'
       ORDER BY send_at ASC`
    )
    .all(accountId) as OutboxRow[]
}

/**
 * Scheduled sends still waiting, across every listed account, soonest first.
 * A reply from the unified inbox queues under the account that received the
 * mail, so the scheduled list must not stop at the active account.
 * Rows due at or before `after` (still inside the undo window) are left out.
 */
export function listScheduledOutbox(accountIds: number[], after: number): OutboxRow[] {
  if (accountIds.length === 0) return []
  return getDb()
    .prepare(
      `SELECT * FROM outbox
       WHERE account_id IN (${accountIds.map(() => '?').join(',')})
         AND status = 'pending' AND send_at > ?
       ORDER BY send_at ASC, id ASC`
    )
    .all(...accountIds, after) as OutboxRow[]
}

export function listDueOutbox(now = Date.now()): OutboxRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM outbox
       WHERE status = 'pending' AND send_at <= ?
       ORDER BY send_at ASC
       LIMIT 20`
    )
    .all(now) as OutboxRow[]
}

export function markOutboxSending(id: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE outbox SET status = 'sending'
       WHERE id = ? AND status = 'pending'`
    )
    .run(id)
  return info.changes > 0
}

export function markOutboxSent(id: number): void {
  getDb().prepare(`UPDATE outbox SET status = 'sent', error = NULL WHERE id = ?`).run(id)
}

export function markOutboxFailed(id: number, error: string): void {
  getDb()
    .prepare(`UPDATE outbox SET status = 'failed', error = ? WHERE id = ?`)
    .run(error, id)
}
