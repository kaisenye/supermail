import { getDb } from '../store/db.js'

/** Background AI only looks at mail this recent: turning a feature on never back-fills history. */
export const FRESH_MS = 48 * 3600_000

/** One message as background AI sees it (candidate()). */
export interface Candidate {
  id: number
  account_id: number
  message_id: string | null
  thread_id: string | null
  from_addr: string | null
  /** The account's address, lower case. */
  me: string
  role: string | null
  bulk: number
  list_unsubscribe: string | null
  to_addrs: string | null
  cc_addrs: string | null
  date: number | null
  /** From list_rows: the last word in the thread is mine. */
  last_from_me: number
}

const NOTIFY_LOCAL =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|automated|system)([+._-].*)?$/i

export function isNotificationSender(addr: string | null): boolean {
  const local = (addr ?? '').split('@')[0]
  return NOTIFY_LOCAL.test(local)
}

function addresses(json: string | null): string[] {
  try {
    const v: unknown = JSON.parse(json ?? '[]')
    return Array.isArray(v)
      ? v.flatMap((x) => (x && typeof x === 'object' && typeof (x as { address?: unknown }).address === 'string'
          ? [((x as { address: string }).address).toLowerCase()]
          : []))
      : []
  } catch {
    return []
  }
}

export function addressedToMe(c: Candidate): boolean {
  return [...addresses(c.to_addrs), ...addresses(c.cc_addrs)].includes(c.me)
}

/** Fresh, non-bulk Inbox mail from someone else, with a Message-ID to key results on. */
export function classifyEligible(c: Candidate, now: number): boolean {
  return (
    !!c.message_id &&
    c.role === 'inbox' &&
    (c.from_addr ?? '').toLowerCase() !== c.me &&
    !c.bulk &&
    !c.list_unsubscribe &&
    (c.date ?? 0) >= now - FRESH_MS
  )
}

/**
 * Mail a person wrote to me that I have not answered. Bulk and notification
 * mail never gets suggestions. `fresh: false` is the on-demand path.
 */
export function repliesEligible(c: Candidate, now: number, opts: { fresh: boolean }): boolean {
  const recentEnough = opts.fresh ? (c.date ?? 0) >= now - FRESH_MS : true
  return (
    !!c.message_id &&
    c.role === 'inbox' &&
    (c.from_addr ?? '').toLowerCase() !== c.me &&
    !c.bulk &&
    !c.list_unsubscribe &&
    recentEnough &&
    !isNotificationSender(c.from_addr) &&
    addressedToMe(c) &&
    !c.last_from_me
  )
}

/** Reads list_rows as it stands; callers that need it current run refreshListRows() first. */
export function candidate(messageRowId: number): Candidate | null {
  return (
    (getDb()
      .prepare(
        `SELECT m.id, m.account_id, m.message_id, m.thread_id, m.from_addr, lower(a.email) AS me, f.role,
                COALESCE(m.bulk, 0) AS bulk, m.list_unsubscribe, m.to_addrs, m.cc_addrs, m.date,
                COALESCE((SELECT lr.last_from_me FROM list_rows lr
                           WHERE lr.account_id = m.account_id
                             AND lr.thread_key = COALESCE(m.thread_id, '#' || m.id) LIMIT 1), 0) AS last_from_me
           FROM messages m
           JOIN accounts a ON a.id = m.account_id
           LEFT JOIN folders f ON f.id = m.folder_id
          WHERE m.id = ?`
      )
      .get(messageRowId) as Candidate | undefined) ?? null
  )
}

/** The Inbox copy of a message, which is what background AI works on. */
export function inboxCopyOf(accountId: number, messageId: string): number | null {
  const r = getDb()
    .prepare(
      `SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id
        WHERE m.account_id = ? AND m.message_id = ? AND f.role = 'inbox' LIMIT 1`
    )
    .get(accountId, messageId) as { id: number } | undefined
  return r?.id ?? null
}
