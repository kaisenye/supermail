import { getDb } from './db.js'
import { listFolders } from './repo.js'
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

/**
 * The labels a selection can take: those every owning account has. Empty when
 * any of them is not Gmail. Search results can mix accounts in one selection,
 * and offering one account's labels to another's rows would create a label
 * the user never made on that other server.
 */
export function sharedLabelChoices(accountIds: Iterable<number>, isGmail: (accountId: number) => boolean): string[] {
  let shared: string[] | null = null
  for (const id of accountIds) {
    if (!isGmail(id)) return []
    const mine = new Set(gmailLabelChoices(listFolders(id)))
    shared = shared === null ? [...mine] : shared.filter((l) => mine.has(l))
  }
  return shared ?? []
}

/**
 * Null when `label` may be written to every one of these accounts, else why
 * not. Checked before anything is written, so a bad request changes nothing.
 */
export function labelWriteError(
  accountIds: Iterable<number>,
  label: string,
  isGmail: (accountId: number) => boolean
): string | null {
  for (const id of accountIds) {
    if (!isGmail(id)) return 'Labels are Gmail only'
    if (!gmailLabelChoices(listFolders(id)).includes(label)) return `No label "${label}" on this account`
  }
  return null
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

/** A Gmail label's colours as Gmail defines them: background and text, `#rrggbb`. */
export interface LabelColor {
  bg: string
  fg: string
}

/** Replaces the account's Gmail label colours (v23). A label with none is simply absent. */
export function saveLabelColors(accountId: number, colors: { name: string; bg: string; fg: string }[]): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM gmail_label_colors WHERE account_id = ?').run(accountId)
    const ins = db.prepare('INSERT OR REPLACE INTO gmail_label_colors (account_id, name, bg, fg) VALUES (?, ?, ?, ?)')
    for (const c of colors) ins.run(accountId, c.name, c.bg, c.fg)
  })()
}

export function labelColors(accountId: number): Record<string, LabelColor> {
  const rows = getDb()
    .prepare('SELECT name, bg, fg FROM gmail_label_colors WHERE account_id = ?')
    .all(accountId) as { name: string; bg: string; fg: string }[]
  return Object.fromEntries(rows.map((r) => [r.name, { bg: r.bg, fg: r.fg }]))
}
