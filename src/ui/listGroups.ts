export type ListItem = { kind: 'header'; label: string } | { kind: 'row'; index: number }

// Fixed English names: toLocaleString would make labels (and tests) depend on the machine.
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

/** Built from calendar fields, not ms arithmetic, so DST days are still 1 day. */
function dayStart(now: Date, offsetDays = 0): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays).getTime()
}

export function dateGroup(epoch: number | null, now: Date): string {
  if (!epoch) return 'Older'
  if (epoch >= dayStart(now)) return 'Today'
  if (epoch >= dayStart(now, -1)) return 'Yesterday'
  const sinceMonday = (now.getDay() + 6) % 7
  if (epoch >= dayStart(now, -sinceMonday)) return 'This week'
  if (epoch >= dayStart(now, -sinceMonday - 7)) return 'Last week'
  const d = new Date(epoch)
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/**
 * Rows with a header before each run of the same group. Headers are display
 * only. Grouped on the key the list is sorted by (sort_date, which a fired
 * reminder bumps), so headers stay in order; date is the fallback for lists
 * without one (Drafts).
 */
export function withDateGroups(
  rows: { date: number | null; sort_date?: number | null }[],
  now: Date
): ListItem[] {
  const out: ListItem[] = []
  let last: string | null = null
  rows.forEach((r, index) => {
    const label = dateGroup(r.sort_date ?? r.date, now)
    if (label !== last) {
      out.push({ kind: 'header', label })
      last = label
    }
    out.push({ kind: 'row', index })
  })
  return out
}
