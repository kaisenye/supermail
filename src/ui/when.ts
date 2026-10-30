/** Natural-language times for Remind me. Pure; `now` is injected so tests are fixed. */

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
]
/** Superhuman's default: a reminder with no time lands at the start of the working day. */
const DEFAULT_HOUR = 8

function at(base: Date, h: number, m = 0): Date {
  const d = new Date(base)
  d.setHours(h, m, 0, 0)
  return d
}

function addDays(base: Date, n: number): Date {
  const d = new Date(base)
  d.setDate(d.getDate() + n)
  return d
}

/** The next `weekday` (0 = Sunday) strictly after today. */
function nextWeekday(now: Date, weekday: number): Date {
  return addDays(now, (weekday - now.getDay() + 7) % 7 || 7)
}

export function laterToday(now: Date): Date {
  const d = new Date(now.getTime() + 3 * 3_600_000)
  d.setMinutes(0, 0, 0)
  return d
}

/** '3pm', '3:30pm', '15:00', 'noon'. A bare number is not a time: '3' could be a day. */
export function parseTime(s: string): { h: number; m: number } | null {
  const t = s.trim().toLowerCase()
  if (t === 'noon') return { h: 12, m: 0 }
  if (t === 'midnight') return { h: 0, m: 0 }
  const mt = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t)
  if (!mt) return null
  let h = Number(mt[1])
  const m = Number(mt[2] ?? 0)
  const ap = mt[3]
  if (m > 59) return null
  if (ap) {
    if (h < 1 || h > 12) return null
    if (ap === 'pm' && h !== 12) h += 12
    if (ap === 'am' && h === 12) h = 0
  } else if (mt[2] === undefined) {
    return null
  }
  return h > 23 ? null : { h, m }
}

function monthIndex(word: string): number {
  return word.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(word)) : -1
}

/** A Date in the future, or null when the text is not a time we understand. */
export function parseWhen(text: string, now: Date): Date | null {
  let s = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^(on|at) /, '')
  if (!s) return null

  // A trailing time ('tomorrow 3pm', 'monday at 9am') is peeled off first.
  let time: { h: number; m: number } | null = parseTime(s)
  if (time) {
    s = ''
  } else {
    const tail = /^(.*?)(?: at)? (\S+)$/.exec(s)
    const t = tail ? parseTime(tail[2]) : null
    if (tail && t) {
      time = t
      s = tail[1].trim()
    }
  }
  const h = time?.h ?? DEFAULT_HOUR
  const m = time?.m ?? 0
  const future = (d: Date): Date | null => (d.getTime() > now.getTime() ? d : null)

  if (s === '') {
    const d = at(now, h, m)
    return d > now ? d : addDays(d, 1)
  }
  if (s === 'today') return future(at(now, h, m))
  if (s === 'later' || s === 'later today') return laterToday(now)
  if (s === 'tonight') {
    const d = at(now, time?.h ?? 20, m)
    return d > now ? d : addDays(d, 1)
  }
  if (s === 'tomorrow') return at(addDays(now, 1), h, m)
  if (s === 'next week') return at(nextWeekday(now, 1), h, m)
  if (s === 'weekend' || s === 'this weekend') return at(nextWeekday(now, 6), h, m)

  const rel = /^in (\d+) ?(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|months?)$/.exec(s)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2]
    if (unit.startsWith('mo')) {
      const d = at(now, h, m)
      d.setMonth(d.getMonth() + n)
      return d
    }
    if (unit.startsWith('m')) return new Date(now.getTime() + n * 60_000)
    if (unit.startsWith('h')) return new Date(now.getTime() + n * 3_600_000)
    if (unit.startsWith('w')) return at(addDays(now, 7 * n), h, m)
    return at(addDays(now, n), h, m)
  }

  const day = DAYS.findIndex((dn) => s === dn || s === dn.slice(0, 3) || s === `next ${dn}`)
  if (day >= 0) return at(nextWeekday(now, day), h, m)

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (iso) return future(new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), h, m))

  // 'nov 3' or '3 nov'; a date already past this year means next year's.
  const md = /^([a-z]+) (\d{1,2})$/.exec(s) ?? /^(\d{1,2}) ([a-z]+)$/.exec(s)
  if (md) {
    const word = /\d/.test(md[1]) ? md[2] : md[1]
    const num = Number(/\d/.test(md[1]) ? md[1] : md[2])
    const mi = monthIndex(word)
    if (mi < 0 || num < 1 || num > 31) return null
    const d = new Date(now.getFullYear(), mi, num, h, m)
    return d > now ? d : new Date(now.getFullYear() + 1, mi, num, h, m)
  }
  return null
}

export const PRESETS: { id: string; label: string; at: (now: Date) => Date }[] = [
  { id: 'later', label: 'Later today', at: laterToday },
  { id: 'tomorrow', label: 'Tomorrow', at: (n) => at(addDays(n, 1), DEFAULT_HOUR) },
  { id: 'weekend', label: 'This weekend', at: (n) => at(nextWeekday(n, 6), DEFAULT_HOUR) },
  { id: 'nextWeek', label: 'Next week', at: (n) => at(nextWeekday(n, 1), DEFAULT_HOUR) },
  {
    id: 'month',
    label: 'In a month',
    at: (n) => {
      const d = at(n, DEFAULT_HOUR)
      d.setMonth(d.getMonth() + 1)
      return d
    }
  }
]
