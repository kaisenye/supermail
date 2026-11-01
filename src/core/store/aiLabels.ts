import { getDb } from './db.js'
import { refreshListRows } from './listRows.js'

/** A label the user defined for one inbox (v22 ai_labels). */
export interface AiLabel {
  id: number
  account_id: number
  name: string
  /** What mail belongs under it, in the user's words: what the classifier matches. */
  description: string
}

/** Per inbox, like Superhuman's prompt labels. */
export const MAX_AI_LABELS = 10
/** A new or edited label sorts this much recent Inbox mail. */
export const LABEL_BACKFILL_MS = 14 * 24 * 3600_000

/** Letters, digits, spaces, `-`, `_`, `&`, `/` and `.`, so `ai:"Name"` always parses. */
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _&/.-]*$/u

export function listAiLabels(accountId: number): AiLabel[] {
  return getDb()
    .prepare('SELECT id, account_id, name, description FROM ai_labels WHERE account_id = ? ORDER BY created_at, id')
    .all(accountId) as AiLabel[]
}

export function getAiLabel(id: number): AiLabel | null {
  return (
    (getDb().prepare('SELECT id, account_id, name, description FROM ai_labels WHERE id = ?').get(id) as
      | AiLabel
      | undefined) ?? null
  )
}

/** Creates or edits a label. Throws a message fit to show when the input is not usable. */
export function saveAiLabel(
  input: { id?: number; accountId: number; name: string; description: string },
  now = Date.now()
): AiLabel {
  const name = input.name.trim().replace(/\s+/g, ' ')
  const description = input.description.trim()
  if (!name) throw new Error('A label needs a name')
  if (name.length > 40) throw new Error('Keep the name under 40 characters')
  if (!NAME_RE.test(name)) throw new Error('Use letters, numbers and spaces in the name')
  if (!description) throw new Error('Describe what mail belongs under this label')
  if (description.length > 500) throw new Error('Keep the description under 500 characters')
  const db = getDb()
  const clash = db
    .prepare('SELECT id FROM ai_labels WHERE account_id = ? AND name = ? AND id IS NOT ?')
    .get(input.accountId, name, input.id ?? null)
  if (clash) throw new Error(`There is already a label called ${name}`)
  if (input.id != null) {
    const changed = db
      .prepare('UPDATE ai_labels SET name = ?, description = ? WHERE id = ? AND account_id = ?')
      .run(name, description, input.id, input.accountId).changes
    if (!changed) throw new Error('That label no longer exists')
    return { id: input.id, account_id: input.accountId, name, description }
  }
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM ai_labels WHERE account_id = ?').get(input.accountId) as {
    n: number
  }
  if (n >= MAX_AI_LABELS) throw new Error(`An inbox can have up to ${MAX_AI_LABELS} labels`)
  const id = Number(
    db
      .prepare('INSERT INTO ai_labels (account_id, name, description, created_at) VALUES (?, ?, ?, ?)')
      .run(input.accountId, name, description, now).lastInsertRowid
  )
  return { id, account_id: input.accountId, name, description }
}

/** Deletes the label; its verdicts go with it (ON DELETE CASCADE). */
export function deleteAiLabel(id: number): AiLabel | null {
  const label = getAiLabel(id)
  if (label) getDb().prepare('DELETE FROM ai_labels WHERE id = ?').run(id)
  return label
}

/** Replaces one message's labels with `labelIds` (empty clears them). */
export function setMessageLabels(accountId: number, messageId: string, labelIds: number[]): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM ai_message_labels WHERE account_id = ? AND message_id = ?').run(accountId, messageId)
    const ins = db.prepare(
      `INSERT OR IGNORE INTO ai_message_labels (account_id, message_id, label_id)
       SELECT ?, ?, id FROM ai_labels WHERE id = ? AND account_id = ?`
    )
    for (const id of labelIds) ins.run(accountId, messageId, id, accountId)
  })()
}

export function messageLabelNames(accountId: number, messageId: string): string[] {
  return (
    getDb()
      .prepare(
        `SELECT l.name FROM ai_message_labels x JOIN ai_labels l ON l.id = x.label_id
          WHERE x.account_id = ? AND x.message_id = ? ORDER BY l.created_at, l.id`
      )
      .all(accountId, messageId) as { name: string }[]
  ).map((r) => r.name)
}

/** Drops every custom-label verdict (the classifier was turned off). The labels themselves stay. */
export function clearMessageLabels(): number {
  return getDb().prepare('DELETE FROM ai_message_labels').run().changes
}

/**
 * Queues a `labels` job for the account's recent Inbox mail from other people,
 * newest first: new ones, and ones already labelled (back to pending), since a
 * new or edited label changes the answer. Returns how many were queued.
 */
export function queueLabelBackfill(accountId: number, now = Date.now(), windowMs = LABEL_BACKFILL_MS): number {
  const db = getDb()
  return db.transaction(() => {
    const ids = db
      .prepare(
        `SELECT DISTINCT m.message_id FROM messages m
           JOIN folders f ON f.id = m.folder_id AND f.role = 'inbox'
           JOIN accounts a ON a.id = m.account_id
          WHERE m.account_id = ? AND m.message_id IS NOT NULL AND m.date >= ?
            AND lower(COALESCE(m.from_addr, '')) <> lower(a.email)`
      )
      .all(accountId, now - windowMs) as { message_id: string }[]
    const reset = db.prepare(
      `UPDATE ai_jobs SET status = 'pending', attempts = 0, next_at = 0, error = NULL, created_at = ?
        WHERE account_id = ? AND message_id = ? AND kind = 'labels'`
    )
    const add = db.prepare(
      "INSERT OR IGNORE INTO ai_jobs (account_id, message_id, kind, created_at) VALUES (?, ?, 'labels', ?)"
    )
    for (const { message_id } of ids) {
      if (!reset.run(now, accountId, message_id).changes) add.run(accountId, message_id, now)
    }
    return ids.length
  })()
}

/**
 * What the sidebar's Labels section lists for an inbox: the classifier's
 * categories that some Inbox conversation on show has ("other" says nothing,
 * so it is left out), and every label the inbox defined, mail or not.
 */
export function sidebarLabels(accountId: number): { categories: string[]; labels: string[] } {
  refreshListRows()
  const db = getDb()
  const categories = (
    db
      .prepare(
        `SELECT DISTINCT lr.ai_category AS c FROM list_rows lr
           JOIN folders f ON f.id = lr.folder_id AND f.role = 'inbox'
          WHERE lr.account_id = ? AND lr.hidden = 0
            AND lr.ai_category IS NOT NULL AND lr.ai_category <> 'other'`
      )
      .all(accountId) as { c: string }[]
  ).map((r) => r.c)
  return { categories, labels: listAiLabels(accountId).map((l) => l.name) }
}
