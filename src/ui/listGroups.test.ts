import { describe, expect, it } from 'vitest'
import { dateGroup, withDateGroups } from './listGroups.js'

// Thursday 29 October 2026, 10:00 local.
const NOW = new Date(2026, 9, 29, 10, 0)
const at = (m: number, d: number, h = 9) => new Date(2026, m, d, h).getTime()

describe('date groups', () => {
  it('labels days, weeks and months', () => {
    expect(dateGroup(at(9, 29), NOW)).toBe('Today')
    expect(dateGroup(at(9, 28), NOW)).toBe('Yesterday')
    expect(dateGroup(at(9, 26), NOW)).toBe('This week')
    expect(dateGroup(at(9, 19), NOW)).toBe('Last week')
    expect(dateGroup(at(9, 18), NOW)).toBe('October 2026')
    expect(dateGroup(at(8, 30), NOW)).toBe('September 2026')
    expect(dateGroup(null, NOW)).toBe('Older')
  })

  it('puts a header before each run of rows', () => {
    const rows = [{ date: at(9, 29) }, { date: at(9, 29, 8) }, { date: at(9, 20) }]
    expect(withDateGroups(rows, NOW)).toEqual([
      { kind: 'header', label: 'Today' },
      { kind: 'row', index: 0 },
      { kind: 'row', index: 1 },
      { kind: 'header', label: 'Last week' },
      { kind: 'row', index: 2 }
    ])
  })

  it('groups on sort_date, so a fired reminder at the top sits under Today, not last month', () => {
    // A September message whose reminder fired today, then today's mail.
    const rows = [
      { date: at(8, 10), sort_date: at(9, 29, 9) },
      { date: at(9, 29, 8), sort_date: at(9, 29, 8) },
      { date: at(8, 12), sort_date: at(8, 12) }
    ]
    expect(withDateGroups(rows, NOW)).toEqual([
      { kind: 'header', label: 'Today' },
      { kind: 'row', index: 0 },
      { kind: 'row', index: 1 },
      { kind: 'header', label: 'September 2026' },
      { kind: 'row', index: 2 }
    ])
  })
})
