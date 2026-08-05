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
}

export function enqueueOutbox(input: EnqueueOutboxInput): OutboxRow {
  const db = getDb()
  const created_at = Date.now()
  const info = db
    .prepare(
      `INSERT INTO outbox (
         account_id, draft_message_id, to_addrs, cc_addrs, bcc_addrs,
         subject, body_text, body_html, in_reply_to, references_header,
         attachments, send_at, status, created_at
       ) VALUES (
         @account_id, @draft_message_id, @to_addrs, @cc_addrs, @bcc_addrs,
         @subject, @body_text, @body_html, @in_reply_to, @references_header,
         @attachments, @send_at, 'pending', @created_at
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
