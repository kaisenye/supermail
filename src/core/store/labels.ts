import { getDb } from './db.js'
import type { Folder } from './types.js'

/** Gmail system labels (\Inbox, \Important, \Starred…) are folders or flags here, never labels. */
export function userLabels(labels: string[]): string[] {
  return [...new Set(labels.filter((l) => l && !l.startsWith('\\')))]
}

/**
 * Labels a Gmail account can apply: its user-label folders. Phase 1 stores
 * every Gmail folder but syncs only system ones, so these rows exist and stay
 * empty; their paths are exactly the X-GM-LABELS names.
 */
export function gmailLabelChoices(folders: Pick<Folder, 'path' | 'role'>[]): string[] {
  return folders
    .filter(
      (f) =>
        f.role === null &&
        f.path.toUpperCase() !== 'INBOX' &&
        !f.path.startsWith('[Gmail]') &&
        !f.path.startsWith('[Google Mail]')
    )
    .map((f) => f.path)
    .sort((a, b) => a.localeCompare(b))
}

function labelId(accountId: number, name: string): number {
  const db = getDb()
  db.prepare('INSERT OR IGNORE INTO labels (account_id, name) VALUES (?, ?)').run(accountId, name)
  return (
    db.prepare('SELECT id FROM labels WHERE account_id = ? AND name = ?').get(accountId, name) as {
      id: number
    }
  ).id
}

export function messageLabels(messageId: number): string[] {
  return (
    getDb()
      .prepare(
        `SELECT l.name FROM message_labels ml JOIN labels l ON l.id = ml.label_id
          WHERE ml.message_id = ? ORDER BY l.name`
      )
      .all(messageId) as { name: string }[]
  ).map((r) => r.name)
}

/** Replaces a message's labels with `names` (system labels dropped). True when anything changed. */
export function setMessageLabels(messageId: number, accountId: number, names: string[]): boolean {
  const want = new Set(userLabels(names))
  const have = new Set(messageLabels(messageId))
  if (want.size === have.size && [...want].every((n) => have.has(n))) return false
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM message_labels WHERE message_id = ?').run(messageId)
    const ins = db.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)')
    for (const n of want) ins.run(messageId, labelId(accountId, n))
  })()
  return true
}

export function addMessageLabel(messageId: number, accountId: number, name: string): boolean {
  return (
    getDb()
      .prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)')
      .run(messageId, labelId(accountId, name)).changes > 0
  )
}

export function removeMessageLabel(messageId: number, accountId: number, name: string): boolean {
  return (
    getDb()
      .prepare(
        `DELETE FROM message_labels WHERE message_id = ?
           AND label_id = (SELECT id FROM labels WHERE account_id = ? AND name = ?)`
      )
      .run(messageId, accountId, name).changes > 0
  )
}

export function labelsForMessages(ids: number[]): Record<number, string[]> {
  return Object.fromEntries(ids.map((id) => [id, messageLabels(id)]))
}
