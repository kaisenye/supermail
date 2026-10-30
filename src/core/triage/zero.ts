import { getDb } from '../store/db.js'
import { refreshListRows } from '../store/listRows.js'

export interface ZeroOptions {
  olderThanDays: number
  keepUnread: boolean
  keepStarred: boolean
}

/**
 * Newest-message ids of the visible conversations Get me to zero would mark Done.
 * Age is the list's own recency (sort_date), so a thread whose reminder just
 * fired counts as fresh, the same as where the Inbox shows it.
 */
export function zeroCandidates(folderId: number, opts: ZeroOptions, now = Date.now()): number[] {
  refreshListRows()
  const cutoff = now - Math.max(0, opts.olderThanDays) * 86_400_000
  const rows = getDb()
    .prepare(
      `SELECT newest_id FROM list_rows
        WHERE folder_id = ? AND hidden = 0 AND sort_date < ?
          ${opts.keepUnread ? 'AND unread_count = 0' : ''}
          ${opts.keepStarred ? 'AND flagged = 0' : ''}`
    )
    .all(folderId, cutoff) as { newest_id: number }[]
  return rows.map((r) => r.newest_id)
}
