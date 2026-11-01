import { getDb } from './db.js'
import { countView } from './listRows.js'

export interface Split {
  /** Built-ins use a word; custom splits are `custom:<row id>`. */
  id: string
  name: string
  /** A list-context query (search.ts LIST_IS plus field operators). */
  query: string
  builtin: boolean
}

export const BUILTIN_SPLITS: Split[] = [
  { id: 'all', name: 'All', query: '', builtin: true },
  { id: 'important', name: 'Important', query: 'is:important', builtin: true },
  { id: 'other', name: 'Other', query: 'is:other', builtin: true }
]

const PREFIX = 'custom:'

export function listSplits(): Split[] {
  const rows = getDb()
    .prepare('SELECT id, name, query FROM splits ORDER BY sort_order, id')
    .all() as { id: number; name: string; query: string }[]
  return [
    ...BUILTIN_SPLITS,
    ...rows.map((r) => ({ id: `${PREFIX}${r.id}`, name: r.name, query: r.query, builtin: false }))
  ]
}

export function saveSplit(input: { id?: string; name: string; query: string }): Split {
  const name = input.name.trim()
  const query = input.query.trim()
  if (!name || !query) throw new Error('A split needs a name and a query')
  const db = getDb()
  if (input.id?.startsWith(PREFIX)) {
    db.prepare('UPDATE splits SET name = ?, query = ? WHERE id = ?').run(
      name,
      query,
      Number(input.id.slice(PREFIX.length))
    )
    return { id: input.id, name, query, builtin: false }
  }
  const { m } = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM splits').get() as {
    m: number
  }
  const id = Number(
    db
      .prepare('INSERT INTO splits (name, query, sort_order) VALUES (?, ?, ?)')
      .run(name, query, m + 1).lastInsertRowid
  )
  return { id: `${PREFIX}${id}`, name, query, builtin: false }
}

export function deleteSplit(id: string): void {
  if (!id.startsWith(PREFIX)) return
  getDb().prepare('DELETE FROM splits WHERE id = ?').run(Number(id.slice(PREFIX.length)))
}

/** Conversations per split for one folder, with an optional chip query ANDed on. */
export function splitCounts(folderId: number, extraQuery = ''): Record<string, number> {
  return Object.fromEntries(
    listSplits().map((s) => [s.id, countView(folderId, { query: `${s.query} ${extraQuery}`.trim() })])
  )
}
