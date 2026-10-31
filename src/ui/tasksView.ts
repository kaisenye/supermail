/** Pure helpers behind the Tasks page: buckets, quick add, due labels. */

const DAY = 86_400_000
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function startOfDay(ms: number): number {
  return new Date(ms).setHours(0, 0, 0, 0)
}

/** Local midday of the day `offset` days from `now`: midnight would flip across timezones. */
export function middayIn(offset: number, now = Date.now()): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, 12, 0, 0, 0).getTime()
}

/** Whole calendar days from today to `due` (negative when past). */
function daysFrom(due: number, now: number): number {
  return Math.round((startOfDay(due) - startOfDay(now)) / DAY)
}

export function dueLabel(due: number, now = Date.now()): { text: string; tone: 'overdue' | 'soon' | 'later' } {
  const days = daysFrom(due, now)
  if (days < 0) return { text: days === -1 ? 'Yesterday' : `${-days} days overdue`, tone: 'overdue' }
  if (days === 0) return { text: 'Today', tone: 'soon' }
  if (days === 1) return { text: 'Tomorrow', tone: 'soon' }
  const d = new Date(due)
  if (days < 7) return { text: WEEKDAYS[d.getDay()], tone: 'later' }
  return { text: `${MONTHS[d.getMonth()]} ${d.getDate()}`, tone: 'later' }
}

interface Sortable {
  id: number
  due_at: number | null
  priority: number
  sort_order: number
}

export interface TaskSection<T> {
  label: 'Overdue' | 'Today' | 'Upcoming' | 'No date'
  tasks: T[]
}

/** Priority 0 is "none", so it sorts after 4 (low). */
const rankPriority = (p: number): number => (p === 0 ? 5 : p)

/**
 * Open tasks in the order you act on them: overdue, today, upcoming, then
 * undated; within a bucket by due date, urgency, then your own order.
 */
export function taskSections<T extends Sortable>(tasks: T[], now = Date.now()): TaskSection<T>[] {
  const buckets: Record<TaskSection<T>['label'], T[]> = { Overdue: [], Today: [], Upcoming: [], 'No date': [] }
  for (const t of tasks) {
    if (t.due_at == null) buckets['No date'].push(t)
    else {
      const days = daysFrom(t.due_at, now)
      buckets[days < 0 ? 'Overdue' : days === 0 ? 'Today' : 'Upcoming'].push(t)
    }
  }
  const order = (a: T, b: T): number =>
    (a.due_at ?? 0) - (b.due_at ?? 0) ||
    rankPriority(a.priority) - rankPriority(b.priority) ||
    a.sort_order - b.sort_order
  return (Object.keys(buckets) as TaskSection<T>['label'][])
    .filter((label) => buckets[label].length)
    .map((label) => ({ label, tasks: buckets[label].sort(order) }))
}

/**
 * "Call Bill tomorrow" → title "Call Bill", due tomorrow. Only a trailing
 * word counts, and never the whole title, so "today" alone stays a title.
 */
export function parseQuickTask(text: string, now = Date.now()): { title: string; due_at: number | null } | null {
  const raw = text.trim()
  if (!raw) return null
  const rules: [RegExp, () => number][] = [
    [/\s+today$/i, () => middayIn(0, now)],
    [/\s+tomorrow$/i, () => middayIn(1, now)],
    // The coming Monday.
    [/\s+next week$/i, () => middayIn(((8 - new Date(now).getDay()) % 7) || 7, now)]
  ]
  for (const [re, due] of rules) {
    if (re.test(raw)) return { title: raw.replace(re, '').trim(), due_at: due() }
  }
  return { title: raw, due_at: null }
}
