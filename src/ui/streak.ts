export interface Streak {
  days: number
  lastDay: string | null
}

/** Local calendar day, YYYY-MM-DD. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Consecutive days that reached inbox zero. Reaching it twice in a day counts once. */
export function nextStreak(prev: Streak, today: string): Streak {
  if (prev.lastDay === today) return prev
  const [y, m, d] = today.split('-').map(Number)
  const yesterday = dayKey(new Date(y, m - 1, d - 1))
  return { days: prev.lastDay === yesterday ? prev.days + 1 : 1, lastDay: today }
}

export interface ZeroView {
  /** Plain Inbox: the Inbox folder with the All split and no chip. */
  plainInbox: boolean
  /** Conversations in the whole view, not just the current page. */
  total: number
  hasSyncedOnce: boolean
  syncError: string | null
}

/**
 * True only when the Inbox is really empty: synced at least once, no sync
 * error, and no conversations on any page. An empty page 2 or an empty
 * pre-sync paint is not inbox zero.
 */
export function isInboxZero(v: ZeroView): boolean {
  return v.plainInbox && v.total === 0 && v.hasSyncedOnce && !v.syncError
}
