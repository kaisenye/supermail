import type { ImapFlow } from 'imapflow'
import { getDb } from '../store/db.js'
import { listHeadersFrom } from '../pipeline/listHeaders.js'
import { ENVELOPE_HEADERS } from './imap.js'

/**
 * Fills list_unsubscribe / unsubscribe_one_click / bulk for mail synced before
 * migration v18. Raw headers are not stored, so the migration cannot do it, and
 * the pipeline only re-reads headers on new envelopes or unfetched bodies.
 * Pulls the header lines only (never bodies), like the threading repair.
 */

export interface HeaderBackfillResult {
  scanned: number
  updated: number
}

const BATCH = 500

/**
 * Rows that may predate v18. Anything already flagged was read by the new
 * pipeline; mail with no list headers is re-checked once, harmlessly.
 */
function candidates(accountId: number, folderId: number): number[] {
  return (
    getDb()
      .prepare(
        `SELECT uid FROM messages
          WHERE account_id = ? AND folder_id = ? AND uid IS NOT NULL
            AND list_unsubscribe IS NULL AND bulk = 0
          ORDER BY uid`
      )
      .all(accountId, folderId) as { uid: number }[]
  ).map((r) => r.uid)
}

export async function backfillListHeaders(
  client: ImapFlow,
  accountId: number,
  folders: { id: number; path: string }[]
): Promise<HeaderBackfillResult> {
  const update = getDb().prepare(
    `UPDATE messages SET list_unsubscribe = ?, unsubscribe_one_click = ?, bulk = ?
      WHERE account_id = ? AND folder_id = ? AND uid = ?`
  )
  let scanned = 0
  let updated = 0

  for (const f of folders) {
    const uids = candidates(accountId, f.id)
    if (!uids.length) continue
    scanned += uids.length
    const wanted = new Set(uids)

    const found: { uid: number; unsub: string | null; oneClick: number; bulk: number }[] = []
    const lock = await client.getMailboxLock(f.path)
    try {
      for (let i = 0; i < uids.length; i += BATCH) {
        for await (const msg of client.fetch(
          uids.slice(i, i + BATCH).join(','),
          { uid: true, headers: [...ENVELOPE_HEADERS] },
          { uid: true }
        )) {
          if (!wanted.has(msg.uid) || !msg.headers) continue
          const lh = listHeadersFrom(msg.headers.toString('utf8'))
          // Nothing to record: the row already says "not bulk, no unsubscribe".
          if (!lh.bulk && !lh.unsubscribe && !lh.oneClick) continue
          found.push({
            uid: msg.uid,
            unsub: lh.unsubscribe,
            oneClick: lh.oneClick ? 1 : 0,
            bulk: lh.bulk ? 1 : 0
          })
        }
      }
    } finally {
      lock.release()
    }

    // list_dirty_au fires on the bulk change, so list_rows picks this up.
    getDb().transaction(() => {
      for (const r of found) {
        updated += update.run(r.unsub, r.oneClick, r.bulk, accountId, f.id, r.uid).changes
      }
    })()
  }

  return { scanned, updated }
}
