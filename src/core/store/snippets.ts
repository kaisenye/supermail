import { getDb } from './db.js'

/** A plain-text template with {variables}; global, like splits. */
export interface Snippet {
  id: number
  name: string
  /** Typed after `;` in the compose body, then ⇥. */
  shortcut: string | null
  body: string
  created_at: number
  updated_at: number
}

const SHORTCUT_RE = /^[a-z0-9_-]{1,24}$/i

export function listSnippets(): Snippet[] {
  return getDb().prepare('SELECT * FROM snippets ORDER BY lower(name), id').all() as Snippet[]
}

export function saveSnippet(input: { id?: number; name: string; shortcut?: string | null; body: string }): Snippet {
  const name = input.name.trim()
  const body = input.body.replace(/\s+$/, '')
  const shortcut = input.shortcut?.trim().replace(/^;/, '') || null
  if (!name || !body.trim()) throw new Error('A snippet needs a name and some text')
  if (shortcut && !SHORTCUT_RE.test(shortcut)) throw new Error('Shortcut: letters, digits, - or _, up to 24')
  const db = getDb()
  const now = Date.now()
  try {
    if (input.id) {
      db.prepare('UPDATE snippets SET name = ?, shortcut = ?, body = ?, updated_at = ? WHERE id = ?').run(
        name,
        shortcut,
        body,
        now,
        input.id
      )
      return db.prepare('SELECT * FROM snippets WHERE id = ?').get(input.id) as Snippet
    }
    return db
      .prepare(
        'INSERT INTO snippets (name, shortcut, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *'
      )
      .get(name, shortcut, body, now, now) as Snippet
  } catch (e) {
    // idx_snippets_shortcut is unique on lower(shortcut).
    if (/UNIQUE/i.test((e as Error).message)) throw new Error(`;${shortcut} is already used by another snippet`)
    throw e
  }
}

export function deleteSnippet(id: number): void {
  getDb().prepare('DELETE FROM snippets WHERE id = ?').run(id)
}
