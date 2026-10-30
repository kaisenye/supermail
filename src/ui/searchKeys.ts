/** Steps through the search page's scopes. */
export interface ScopeKey {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

/**
 * How far a key moves the search scope: Tab +1, Shift+Tab -1, else 0.
 * Modifier chords (Ctrl+Tab switches the workspace tab) are left to the registry.
 */
export function scopeStep(e: ScopeKey): -1 | 0 | 1 {
  if (e.metaKey || e.ctrlKey || e.altKey || e.key !== 'Tab') return 0
  return e.shiftKey ? -1 : 1
}

export type SearchScope = 'emails' | 'contacts' | 'tasks'

/**
 * The search page's results, kept in the store (not the component) so opening
 * a result and pressing Esc repaints the page at once, on the same scope and
 * row, and so j/k inside that thread can step through the email results.
 */
export interface SearchCache<E, C, T> {
  /** The trimmed query these results answer. */
  query: string
  scope: SearchScope
  active: number
  emails: E[]
  contacts: C[]
  tasks: T[]
}

/** The cache when it answers `query`, else null (a new query searches again). */
export function restoreSearch<E, C, T>(
  cache: SearchCache<E, C, T> | null,
  query: string
): SearchCache<E, C, T> | null {
  return cache && cache.query === query.trim() ? cache : null
}

/** The line shown in place of results, or null when there are results (or no query). */
export function searchStatus(s: { query: string; loading: boolean; error: string | null; count: number }): string | null {
  const q = s.query.trim()
  if (!q) return null
  if (s.error) return `Search failed: ${s.error}`
  if (s.count > 0) return null
  return s.loading ? 'Searching…' : `No results for “${q}”`
}
