import type { ImapFlow } from 'imapflow'
import { getDb } from '../store/db.js'

/** Operators only the local list understands; Gmail would read them as words. */
const LOCAL_ONLY = /(^|\s)-?is:(needs-reply|waiting|important|other|vip|bulk)(?=\s|$)/gi

/** The query to send as X-GM-RAW. Everything else is Gmail syntax already. */
export function gmailRawQuery(query: string): string {
  return query.replace(LOCAL_ONLY, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Server hits with no local row in this folder, newest (highest uid) first, at
 * most `limit`. `skip` holds source uids of moves not yet on the server (held in
 * the undo window or queued in move_jobs): the local row already sits in the
 * destination with uid NULL, so storing the source copy again would duplicate it.
 */
export function missingUids(
  folderId: number,
  uids: number[],
  limit: number,
  skip: Iterable<number> = []
): number[] {
  const skipped = new Set(skip)
  uids = uids.filter((u) => !skipped.has(u))
  if (!uids.length) return []
  const have = new Set(
    (
      getDb()
        .prepare(
          `SELECT uid FROM messages
            WHERE folder_id = ? AND uid IN (SELECT value FROM json_each(?))`
        )
        .all(folderId, JSON.stringify(uids)) as { uid: number }[]
    ).map((r) => r.uid)
  )
  return [...new Set(uids)]
    .filter((u) => !have.has(u))
    .sort((a, b) => b - a)
    .slice(0, limit)
}

/**
 * X-GM-RAW search in one mailbox: the hit uids plus the UIDVALIDITY they are
 * numbered under, read while the lock is held so the two always agree.
 */
export async function gmailSearchUids(
  client: ImapFlow,
  path: string,
  raw: string
): Promise<{ uids: number[]; uidValidity: number }> {
  const lock = await client.getMailboxLock(path)
  try {
    const r = await client.search({ gmraw: raw }, { uid: true })
    return { uids: r || [], uidValidity: liveUidValidity(client) }
  } finally {
    lock.release()
  }
}

/** The open mailbox's UIDVALIDITY (NaN if none); call while holding its lock. */
export function liveUidValidity(client: ImapFlow): number {
  const mb = client.mailbox as { uidValidity?: bigint | number } | false
  return mb && mb.uidValidity != null ? Number(mb.uidValidity) : NaN
}
