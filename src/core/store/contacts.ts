import { getDb } from './db.js'
import { LIST_COLS } from './repo.js'
import type { MessageListRow } from './types.js'

export interface ContactProfile {
  address: string
  name: string | null
  /** Messages from them. */
  received: number
  /** Messages from you with them in To or Cc. */
  sent: number
  /** Conversations they wrote in, and how many of those you also wrote in. */
  threads: number
  repliedThreads: number
  lastContact: number | null
  /** Newest message per conversation with them, newest first. */
  recent: MessageListRow[]
}

const M_COLS = LIST_COLS.split(', ')
  .map((c) => `m.${c}`)
  .join(', ')

const inRecipients = (col: string): string =>
  `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${col}) THEN ${col} ELSE '[]' END) v
            WHERE lower(json_extract(v.value, '$.address')) = @addr)`

function myAddress(accountId: number): string | null {
  const r = getDb().prepare('SELECT lower(email) AS e FROM accounts WHERE id = ?').get(accountId) as
    | { e: string }
    | undefined
  return r?.e ?? null
}

/** Everything the contact pane shows about one person, from synced mail of one account. */
export function contactProfile(accountId: number, address: string, limit = 8): ContactProfile | null {
  const addr = address.trim().toLowerCase()
  const me = myAddress(accountId)
  if (!addr || !me) return null
  const p = { acct: accountId, addr, me }
  // lower(m.from_addr) exactly, with no COALESCE: it has to match the
  // idx_messages_from expression to use it. This runs on every thread open.
  const theirs = `m.account_id = @acct AND lower(m.from_addr) = @addr AND m.folder_id IS NOT NULL`
  const mineAll = `m.account_id = @acct AND lower(m.from_addr) = @me AND m.folder_id IS NOT NULL`
  const mine = `${mineAll} AND (${inRecipients('m.to_addrs')} OR ${inRecipients('m.cc_addrs')})`
  const db = getDb()
  // One indexed pass over their mail, one over yours.
  const t = db
    .prepare(
      `SELECT count(*) AS received, max(m.date) AS last,
              max(CASE WHEN COALESCE(m.from_name, '') <> '' THEN m.from_name END) AS name
         FROM messages m WHERE ${theirs}`
    )
    .get(p) as { received: number; last: number | null; name: string | null }
  const y = db
    .prepare(`SELECT count(*) AS sent, max(m.date) AS last FROM messages m WHERE ${mine}`)
    .get(p) as { sent: number; last: number | null }
  const lastContact = t.last === null ? y.last : y.last === null ? t.last : Math.max(t.last, y.last)
  const stats = { received: t.received, sent: y.sent, lastContact, name: t.name }
  const replies = db
    .prepare(
      // Your thread keys once, then a join: a per-thread EXISTS on COALESCE(thread_id, …)
      // cannot use the index and rescans the account for every thread.
      `WITH t AS (SELECT DISTINCT COALESCE(m.thread_id, '#' || m.id) AS k FROM messages m WHERE ${theirs}),
            mine AS (SELECT DISTINCT COALESCE(m.thread_id, '#' || m.id) AS k FROM messages m WHERE ${mineAll})
       SELECT count(*) AS threads, count(mine.k) AS repliedThreads
         FROM t LEFT JOIN mine ON mine.k = t.k`
    )
    .get(p) as { threads: number; repliedThreads: number }
  const recent = db
    .prepare(
      // UNION ALL rather than OR, so each leg is an indexed lookup.
      `WITH hits AS (
         SELECT m.id, m.thread_id, m.date FROM messages m WHERE ${theirs}
         UNION ALL
         SELECT m.id, m.thread_id, m.date FROM messages m WHERE ${mine})
       SELECT ${M_COLS} FROM messages m
        WHERE m.id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY COALESCE(thread_id, '#' || id)
                                          ORDER BY date DESC, id DESC) AS rn
              FROM hits)
           WHERE rn = 1)
        ORDER BY m.date DESC, m.id DESC
        LIMIT @limit`
    )
    .all({ ...p, limit }) as MessageListRow[]
  return { address: addr, ...stats, ...replies, recent }
}

/** Whom a thread is with: the newest sender who is not you, else the first recipient of the newest message. */
export function threadCounterpart(accountId: number, threadId: string): string | null {
  const me = myAddress(accountId)
  if (!me) return null
  const rows = getDb()
    .prepare(
      `SELECT from_addr, to_addrs FROM messages
        WHERE account_id = ? AND thread_id = ? AND folder_id IS NOT NULL
        ORDER BY date DESC, id DESC`
    )
    .all(accountId, threadId) as { from_addr: string | null; to_addrs: string | null }[]
  const other = rows.find((r) => r.from_addr && r.from_addr.toLowerCase() !== me)
  if (other?.from_addr) return other.from_addr.toLowerCase()
  for (const r of rows) {
    try {
      const to = JSON.parse(r.to_addrs ?? '[]') as { address?: string }[]
      const a = to.find((x) => x.address && x.address.toLowerCase() !== me)?.address
      if (a) return a.toLowerCase()
    } catch {
      // Not JSON: skip this row.
    }
  }
  return null
}
