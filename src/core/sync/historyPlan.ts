import type { Folder } from '../store/types.js'

type HistoryFolder = Pick<Folder, 'id' | 'path' | 'role'> & { history_complete?: number }

const FIRST = ['inbox', 'sent', 'archive', 'all']
const LAST = ['trash', 'junk', 'drafts']

function rank(f: HistoryFolder): number {
  const i = f.role ? FIRST.indexOf(f.role) : -1
  if (i >= 0) return i
  return f.role && LAST.includes(f.role) ? 99 : 10
}

/** The folder full-history backfill works on next: Inbox, Sent, Done, the rest by path, then Trash / Junk / Drafts. */
export function nextHistoryFolder<T extends HistoryFolder>(folders: T[]): T | null {
  const open = folders.filter((f) => !f.history_complete)
  open.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
  return open[0] ?? null
}
