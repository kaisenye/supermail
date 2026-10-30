import { describe, expect, it } from 'vitest'
import { parseWhen, PRESETS } from './when.js'

// Thursday 29 October 2026, 10:00 local.
const NOW = new Date(2026, 9, 29, 10, 0)
const d = (y: number, m: number, day: number, h = 8, min = 0) => new Date(y, m, day, h, min)

describe('parseWhen', () => {
  it.each([
    ['tomorrow', d(2026, 9, 30)],
    ['tomorrow 3pm', d(2026, 9, 30, 15)],
    ['tomorrow at 15:30', d(2026, 9, 30, 15, 30)],
    ['fri', d(2026, 9, 30)],
    ['thursday', d(2026, 10, 5)],
    ['monday at 9am', d(2026, 10, 2, 9)],
    ['next week', d(2026, 10, 2)],
    ['weekend', d(2026, 9, 31)],
    ['3pm', d(2026, 9, 29, 15)],
    ['9am', d(2026, 9, 30, 9)],
    ['at 4:30pm', d(2026, 9, 29, 16, 30)],
    ['tonight', d(2026, 9, 29, 20)],
    ['later', d(2026, 9, 29, 13)],
    ['in 2 hours', d(2026, 9, 29, 12)],
    ['in 30 min', d(2026, 9, 29, 10, 30)],
    ['in 3 days', d(2026, 10, 1)],
    ['in 1 week', d(2026, 10, 5)],
    ['in 1 month', d(2026, 10, 29)],
    ['2026-11-03', d(2026, 10, 3)],
    ['nov 3 5pm', d(2026, 10, 3, 17)],
    ['3 nov', d(2026, 10, 3)],
    ['jan 5', d(2027, 0, 5)]
  ])('%s', (text, want) => {
    expect(parseWhen(text, NOW)).toEqual(want)
  })

  it.each(['', 'banana', '3', '25:00', 'in lots of days'])('rejects %j', (text) => {
    expect(parseWhen(text, NOW)).toBeNull()
  })

  it('has presets that all land in the future', () => {
    for (const p of PRESETS) expect(p.at(NOW).getTime()).toBeGreaterThan(NOW.getTime())
  })
})
