import { getDb } from '../store/db.js'
import { cancelOutbox } from './outbox.js'

export interface CancelledSend {
  outboxId: number
  accountId: number
  subject: string | null
  to: string
}

/** Mail in these folders is not someone answering you. */
const NOT_A_REPLY = new Set(['sent', 'drafts', 'trash', 'junk'])
const VALID_ID = /^<[^<>\s]+>$/

/** The Message-IDs a send is threaded on: what it replies to, then its References. */
export function outboxThreadIds(row: { in_reply_to: string | null; references_header: string | null }): string[] {
  const refs = (row.references_header ?? '').split(/\s+/)
  return [...new Set([row.in_reply_to ?? '', ...refs].filter((x) => VALID_ID.test(x)))]
}

interface Stored {
  account_id: number
  thread_id: string | null
  in_reply_to: string | null
  date: number | null
  from_l: string
  role: string | null
  me: string
}

interface Pending {
  id: number
  account_id: number
  subject: string | null
  to_addrs: string
  in_reply_to: string | null
  references_header: string | null
  created_at: number
}

/**
 * Called after a synced message is stored. Cancels every pending scheduled
 * send of the same account that opted in, belongs to this message's thread,
 * and was scheduled before the message was sent. Local only, like the outbox:
 * it works while the app runs and syncs.
 */
export function cancelScheduledOnReply(messageRowId: number, now = Date.now()): CancelledSend[] {
  const db = getDb()
  const m = db
    .prepare(
      `SELECT m.account_id, m.thread_id, m.in_reply_to, m.date,
              lower(COALESCE(m.from_addr, '')) AS from_l, f.role, lower(a.email) AS me
         FROM messages m
         JOIN accounts a ON a.id = m.account_id
         JOIN folders f ON f.id = m.folder_id
        WHERE m.id = ?`
    )
    .get(messageRowId) as Stored | undefined
  if (!m || m.from_l === m.me || NOT_A_REPLY.has(m.role ?? '')) return []
  const pending = db
    .prepare(
      `SELECT id, account_id, subject, to_addrs, in_reply_to, references_header, created_at FROM outbox
        WHERE account_id = ? AND status = 'pending' AND cancel_on_reply = 1 AND send_at > ?`
    )
    .all(m.account_id, now) as Pending[]
  const out: CancelledSend[] = []
  for (const row of pending) {
    // An old message re-synced is not an answer to a send scheduled after it.
    if ((m.date ?? now) <= row.created_at) continue
    const ids = outboxThreadIds(row)
    if (!ids.length) continue
    const keys = new Set<string>(ids)
    const threads = db
      .prepare(
        `SELECT DISTINCT thread_id FROM messages
          WHERE account_id = ? AND thread_id IS NOT NULL AND message_id IN (${ids.map(() => '?').join(',')})`
      )
      .all(m.account_id, ...ids) as { thread_id: string }[]
    for (const t of threads) keys.add(t.thread_id)
    const sameThread =
      (m.thread_id !== null && keys.has(m.thread_id)) || (m.in_reply_to !== null && ids.includes(m.in_reply_to))
    if (sameThread && cancelOutbox(row.id))
      out.push({ outboxId: row.id, accountId: row.account_id, subject: row.subject, to: row.to_addrs })
  }
  return out
}

type Listener = (cancelled: CancelledSend[]) => void
const listeners = new Set<Listener>()

/** Main subscribes to tell the renderer; returns the unsubscribe. */
export function onScheduledCancelled(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** cancelScheduledOnReply, then tell every listener about what it cancelled. */
export function cancelAndNotify(messageRowId: number): CancelledSend[] {
  const cancelled = cancelScheduledOnReply(messageRowId)
  if (cancelled.length) for (const l of listeners) l(cancelled)
  return cancelled
}
