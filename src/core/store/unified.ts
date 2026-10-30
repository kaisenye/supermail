import { getDb } from './db.js'
import { folderByRole } from './repo.js'
import { LIST_ROW_COLS, refreshListRows, type ListViewOptions } from './listRows.js'
import { listWhere } from './search.js'
import { listSplits } from './splits.js'
import type { MessageListRow } from './types.js'

/** One account's Inbox. The unified view is a list of these. */
export interface InboxScope {
  accountId: number
  folderId: number
}

/** Each account's Inbox. An account whose first sync has not found one yet is skipped. */
export function inboxScopes(accountIds: number[]): InboxScope[] {
  return accountIds.flatMap((accountId) => {
    const f = folderByRole(accountId, 'inbox')
    return f ? [{ accountId, folderId: f.id }] : []
  })
}

/**
 * Pins every row to its owner: `(lr.account_id = ? AND lr.folder_id = ?) OR …`.
 * thread ids collide across accounts, so no read may match on folder or
 * thread alone.
 */
function scopeWhere(scopes: InboxScope[]): { sql: string; params: number[] } {
  return {
    sql: `(${scopes.map(() => '(lr.account_id = ? AND lr.folder_id = ?)').join(' OR ')})`,
    params: scopes.flatMap((s) => [s.accountId, s.folderId])
  }
}

/** One Inbox's visible rows, filtered like listView. Its ORDER BY is served by idx_list_rows_page. */
const LEG_FROM = `FROM list_rows lr JOIN messages m ON m.id = lr.newest_id AND m.account_id = lr.account_id
        WHERE lr.folder_id = ? AND lr.account_id = ? AND lr.hidden = 0`

/**
 * One page across every Inbox, newest conversation first. Hidden rows are left
 * out, as in listView.
 *
 * A UNION ALL of per-Inbox legs, each taking only its newest offset+limit rows
 * in index order, rather than one OR over every Inbox: the OR has to read and
 * sort every visible row of every account on each page.
 */
export function listUnified(scopes: InboxScope[], opts: ListViewOptions = {}): MessageListRow[] {
  if (!scopes.length) return []
  refreshListRows()
  const w = listWhere(opts.query ?? '')
  const limit = opts.limit ?? 100
  const offset = opts.offset ?? 0
  const leg = `SELECT * FROM (
      SELECT lr.folder_id, lr.thread_key, lr.sort_date, lr.newest_id ${LEG_FROM}${w.sql}
       ORDER BY lr.sort_date DESC, lr.newest_id DESC
       LIMIT ?)`
  const params = scopes.flatMap((s) => [s.folderId, s.accountId, ...w.params, offset + limit])
  return getDb()
    .prepare(
      `SELECT ${LIST_ROW_COLS}
         FROM (SELECT * FROM (${scopes.map(() => leg).join(' UNION ALL ')})
                ORDER BY sort_date DESC, newest_id DESC
                LIMIT ? OFFSET ?) p
         JOIN list_rows lr ON lr.folder_id = p.folder_id AND lr.thread_key = p.thread_key
         JOIN messages m ON m.id = lr.newest_id
        ORDER BY p.sort_date DESC, p.newest_id DESC`
    )
    .all(...params, limit, offset) as MessageListRow[]
}

/** Conversations behind the unified view, for the pager: the sum of per-Inbox counts, filtered like listUnified. */
export function countUnified(scopes: InboxScope[], opts: { query?: string } = {}): number {
  if (!scopes.length) return 0
  refreshListRows()
  const w = listWhere(opts.query ?? '')
  const stmt = getDb().prepare(`SELECT count(*) AS c ${LEG_FROM}${w.sql}`)
  return scopes.reduce((n, s) => n + (stmt.get(s.folderId, s.accountId, ...w.params) as { c: number }).c, 0)
}

/** Unread across every Inbox, for the sidebar badge. Hidden rows do not count. */
export function unifiedUnread(scopes: InboxScope[]): number {
  if (!scopes.length) return 0
  refreshListRows()
  const s = scopeWhere(scopes)
  return (
    getDb()
      .prepare(`SELECT COALESCE(SUM(lr.unread_count), 0) AS c FROM list_rows lr WHERE ${s.sql} AND lr.hidden = 0`)
      .get(...s.params) as { c: number }
  ).c
}

/** Per-split counts for the unified view, with the active chip ANDed on. */
export function unifiedSplitCounts(scopes: InboxScope[], extraQuery = ''): Record<string, number> {
  return Object.fromEntries(
    listSplits().map((sp) => [sp.id, countUnified(scopes, { query: `${sp.query} ${extraQuery}`.trim() })])
  )
}
