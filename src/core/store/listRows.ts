import { getDb } from './db.js'
import { LIST_COLS } from './repo.js'
import { listWhere } from './search.js'
import type { MessageListRow } from './types.js'

/**
 * The list read model: one row per (folder, thread). Triggers on `messages`
 * (migration v18) mark a thread dirty; this rebuilds just those threads, so a
 * list read is one indexed scan of list_rows instead of a GROUP BY per page.
 *
 * Thread state that spans folders (whether the last word is mine, mutes,
 * reminders) is computed over every synced folder of the account, except that
 * Drafts, Trash and Junk never decide the last word or count as a reply;
 * counts and the newest message are per folder.
 * ai_important / ai_category come from the thread's newest classified message (v21), across folders.
 */
export const REBUILD_SQL = `
WITH dm AS (
  SELECT m.id, m.account_id, d.thread_key, m.folder_id, m.date, m.flags,
         lower(COALESCE(m.from_addr, '')) AS from_l, m.bulk, m.message_id
    -- Same pinning for threaded keys, plus the index: otherwise the planner
    -- walks every message of the account and probes list_dirty for each.
    FROM list_dirty d
    CROSS JOIN messages m INDEXED BY idx_messages_account_thread
      ON m.account_id = d.account_id AND m.thread_id = d.thread_key
   WHERE m.folder_id IS NOT NULL
  UNION ALL
  SELECT m.id, m.account_id, d.thread_key, m.folder_id, m.date, m.flags,
         lower(COALESCE(m.from_addr, '')), m.bulk, m.message_id
    -- CROSS JOIN pins list_dirty as the outer loop so each message is a rowid
    -- lookup; left to itself SQLite scans every NULL-thread message and
    -- range-scans list_dirty for each one, which is quadratic.
    FROM list_dirty d
    CROSS JOIN messages m ON m.id = CAST(substr(d.thread_key, 2) AS INTEGER)
   WHERE d.thread_key GLOB '#*' AND m.thread_id IS NULL
     AND m.folder_id IS NOT NULL AND m.account_id = d.account_id
),
ranked AS (
  -- Drafts, Trash and Junk do not speak for the thread: an unsent reply draft
  -- is not the last word, and a junked message is not a reply. counts ranks
  -- them last for t_rank and keeps them out of last_inbound.
  SELECT dm.*, lower(a.email) AS me,
         COALESCE(f.role, '') NOT IN ('drafts', 'trash', 'junk') AS counts,
         ROW_NUMBER() OVER (PARTITION BY dm.account_id, dm.thread_key
                            ORDER BY COALESCE(f.role, '') IN ('drafts', 'trash', 'junk'),
                                     COALESCE(dm.date, 0) DESC, dm.id DESC) AS t_rank,
         ROW_NUMBER() OVER (PARTITION BY dm.account_id, dm.folder_id, dm.thread_key
                            ORDER BY COALESCE(dm.date, 0) DESC, dm.id DESC) AS g_rank
    FROM dm JOIN accounts a ON a.id = dm.account_id
    LEFT JOIN folders f ON f.id = dm.folder_id
),
cls AS (
  -- The thread's newest classified message decides: a later verdict (a new
  -- inbound mail) replaces an older one.
  SELECT ranked.account_id, ranked.thread_key, c.important, c.category,
         ROW_NUMBER() OVER (PARTITION BY ranked.account_id, ranked.thread_key
                            ORDER BY COALESCE(ranked.date, 0) DESC, ranked.id DESC) AS c_rank
    FROM ranked JOIN ai_classifications c
      ON c.account_id = ranked.account_id AND c.message_id = ranked.message_id
),
rem AS (
  SELECT r.account_id, ranked.thread_key, r.created_at, r.fired_at
    FROM ranked JOIN reminders r
      ON r.account_id = ranked.account_id AND r.message_id = ranked.message_id
),
t AS (
  SELECT account_id, thread_key,
         MAX(CASE WHEN t_rank = 1 AND counts THEN from_l = me END) AS last_from_me,
         MAX(CASE WHEN counts AND from_l <> me THEN COALESCE(date, 0) END) AS last_inbound,
         SUM(EXISTS (SELECT 1 FROM mutes x
                      WHERE x.account_id = ranked.account_id
                        AND x.message_id = ranked.message_id)) > 0 AS muted
    FROM ranked GROUP BY account_id, thread_key
),
g AS (
  SELECT account_id, folder_id, thread_key,
         MAX(CASE WHEN g_rank = 1 THEN id END) AS newest_id,
         MAX(date) AS date,
         MAX(CASE WHEN g_rank = 1 THEN from_l END) AS sender,
         MAX(CASE WHEN g_rank = 1 THEN COALESCE(bulk, 0) END) AS bulk,
         COUNT(*) AS msg_count,
         SUM(NOT EXISTS (SELECT 1 FROM json_each(COALESCE(flags, '[]'))
                          WHERE lower(json_each.value) = '\\seen')) AS unread_count,
         SUM(EXISTS (SELECT 1 FROM json_each(COALESCE(flags, '[]'))
                      WHERE lower(json_each.value) = '\\flagged')) > 0 AS flagged
    FROM ranked GROUP BY account_id, folder_id, thread_key
)
INSERT INTO list_rows (account_id, folder_id, thread_key, newest_id, date, sort_date,
                       msg_count, unread_count, flagged, sender, bulk, last_from_me,
                       hidden, reminder_fired, ai_important, ai_category)
SELECT g.account_id, g.folder_id, g.thread_key, g.newest_id, g.date,
       MAX(COALESCE(g.date, 0), COALESCE(
         (SELECT MAX(rem.fired_at) FROM rem
           WHERE rem.account_id = g.account_id AND rem.thread_key = g.thread_key), 0)),
       g.msg_count, g.unread_count, g.flagged, g.sender, COALESCE(g.bulk, 0),
       COALESCE(t.last_from_me, 0),
       -- Remind me and mute are local: they hide the Inbox row only, and any
       -- reply that arrives after the reminder was set brings the thread back.
       f.role IS 'inbox' AND (t.muted OR EXISTS (
         SELECT 1 FROM rem
          WHERE rem.account_id = g.account_id AND rem.thread_key = g.thread_key
            AND rem.fired_at IS NULL AND COALESCE(t.last_inbound, 0) <= rem.created_at)),
       EXISTS (SELECT 1 FROM rem
                WHERE rem.account_id = g.account_id AND rem.thread_key = g.thread_key
                  AND rem.fired_at IS NOT NULL),
       cls.important, cls.category
  FROM g
  JOIN t ON t.account_id = g.account_id AND t.thread_key = g.thread_key
  JOIN folders f ON f.id = g.folder_id
  LEFT JOIN cls ON cls.account_id = g.account_id AND cls.thread_key = g.thread_key AND cls.c_rank = 1
`

/** Rebuilds every dirty thread. Returns how many were dirty; 0 costs one count. */
export function refreshListRows(): number {
  const db = getDb()
  const { c } = db.prepare('SELECT count(*) AS c FROM list_dirty').get() as { c: number }
  if (!c) return 0
  db.transaction(() => {
    db.prepare(
      `DELETE FROM list_rows WHERE EXISTS (
         SELECT 1 FROM list_dirty d
          WHERE d.account_id = list_rows.account_id AND d.thread_key = list_rows.thread_key)`
    ).run()
    db.prepare(REBUILD_SQL).run()
    db.prepare('DELETE FROM list_dirty').run()
  })()
  return c
}

/**
 * Unread per folder, from the read model: rows the list hides (muted, or
 * waiting on a reminder) do not count, so the sidebar badge matches the list.
 */
export function unreadCounts(accountId: number): Record<number, number> {
  refreshListRows()
  const rows = getDb()
    .prepare(
      `SELECT folder_id, SUM(unread_count) c FROM list_rows
        WHERE account_id = ? AND hidden = 0
        GROUP BY folder_id HAVING c > 0`
    )
    .all(accountId) as { folder_id: number; c: number }[]
  return Object.fromEntries(rows.map((r) => [r.folder_id, r.c]))
}

/** Marks the thread(s) holding a Message-ID dirty: reminders and mutes call this. */
export function markDirtyByMessageId(accountId: number, messageId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO list_dirty (account_id, thread_key)
       SELECT account_id, COALESCE(thread_id, '#' || id) FROM messages
        WHERE account_id = ? AND message_id = ? AND folder_id IS NOT NULL`
    )
    .run(accountId, messageId)
}

export interface ListViewOptions {
  limit?: number
  offset?: number
  /** A list-context query (search.ts listWhere): a split and any chips, ANDed. */
  query?: string
}

const M_COLS = LIST_COLS.split(', ')
  .map((c) => `m.${c}`)
  .join(', ')

/** What a list row selects: the newest message's columns plus the thread rollup. */
export const LIST_ROW_COLS = `${M_COLS}, lr.msg_count AS thread_count, lr.unread_count AS thread_unread,
              lr.reminder_fired AS reminder_fired, lr.sort_date AS sort_date,
              lr.ai_important AS ai_important, lr.ai_category AS ai_category,
              (SELECT group_concat(DISTINCT al.name) FROM ai_message_labels x
                 JOIN ai_labels al ON al.id = x.label_id
                 JOIN messages mx ON mx.account_id = x.account_id AND mx.message_id = x.message_id
                WHERE x.account_id = lr.account_id
                  AND COALESCE(mx.thread_id, '#' || mx.id) = lr.thread_key) AS ai_labels`

/** One page of a folder, newest conversation first. Hidden rows (reminders, mutes) are left out. */
export function listView(folderId: number, opts: ListViewOptions = {}): MessageListRow[] {
  refreshListRows()
  const w = listWhere(opts.query ?? '')
  return getDb()
    .prepare(
      `SELECT ${LIST_ROW_COLS}
         FROM list_rows lr JOIN messages m ON m.id = lr.newest_id
        WHERE lr.folder_id = ? AND lr.hidden = 0${w.sql}
        ORDER BY lr.sort_date DESC, lr.newest_id DESC
        LIMIT ? OFFSET ?`
    )
    .all(folderId, ...w.params, opts.limit ?? 100, opts.offset ?? 0) as MessageListRow[]
}

/** Conversations behind a view, for the pager. Mirrors listView's WHERE. */
export function countView(folderId: number, opts: { query?: string } = {}): number {
  refreshListRows()
  const w = listWhere(opts.query ?? '')
  return (
    getDb()
      .prepare(
        `SELECT count(*) AS c FROM list_rows lr JOIN messages m ON m.id = lr.newest_id
          WHERE lr.folder_id = ? AND lr.hidden = 0${w.sql}`
      )
      .get(folderId, ...w.params) as { c: number }
  ).c
}

/** Kept for callers and tests that predate views. */
export function listInbox(folderId: number, limit = 100, offset = 0): MessageListRow[] {
  return listView(folderId, { limit, offset })
}

/**
 * Compares each folder's thread and unread totals with a fresh GROUP BY and
 * rebuilds any folder that disagrees. Returns the folders it repaired. Cheap:
 * two aggregates per account, run after each sync.
 */
export function repairListDrift(accountId: number): number[] {
  refreshListRows()
  const db = getDb()
  const fresh = db
    .prepare(
      `SELECT folder_id, COUNT(DISTINCT COALESCE(thread_id, '#' || id)) AS threads,
              SUM(NOT EXISTS (SELECT 1 FROM json_each(COALESCE(m.flags, '[]'))
                               WHERE lower(json_each.value) = '\\seen')) AS unread
         FROM messages m WHERE account_id = ? AND folder_id IS NOT NULL
        GROUP BY folder_id`
    )
    .all(accountId) as { folder_id: number; threads: number; unread: number }[]
  const model = db
    .prepare(
      `SELECT folder_id, COUNT(*) AS threads, SUM(unread_count) AS unread
         FROM list_rows WHERE account_id = ? GROUP BY folder_id`
    )
    .all(accountId) as { folder_id: number; threads: number; unread: number }[]

  const key = (r: { threads: number; unread: number }) => `${r.threads}/${r.unread}`
  const want = new Map(fresh.map((r) => [r.folder_id, key(r)]))
  const have = new Map(model.map((r) => [r.folder_id, key(r)]))
  const drifted = [...new Set([...want.keys(), ...have.keys()])].filter(
    (f) => want.get(f) !== have.get(f)
  )
  if (!drifted.length) return []

  db.transaction(() => {
    for (const folderId of drifted) {
      db.prepare('DELETE FROM list_rows WHERE folder_id = ?').run(folderId)
      db.prepare(
        `INSERT OR IGNORE INTO list_dirty (account_id, thread_key)
         SELECT account_id, COALESCE(thread_id, '#' || id) FROM messages WHERE folder_id = ?`
      ).run(folderId)
    }
  })()
  refreshListRows()
  return drifted.sort((a, b) => a - b)
}
