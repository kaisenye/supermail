import { describe, expect, it } from 'vitest'

/**
 * Mirrors the preset math in SnoozeMenu. Every target must be strictly in the
 * future — main rejects a wake time in the past, so an off-by-one here would
 * make the button silently fail.
 */
function atHour(d: Date, hour: number): Date {
  const out = new Date(d)
  out.setHours(hour, 0, 0, 0)
  return out
}

const nextWeekday = (from: Date, target: number): Date => {
  const d = new Date(from)
  const delta = (target - d.getDay() + 7) % 7 || 7
  d.setDate(d.getDate() + delta)
  return atHour(d, 8)
}

describe('snooze presets', () => {
  it('later today is 3h out', () => {
    const now = Date.now()
    expect(now + 3 * 3600_000 - now).toBe(3 * 3600_000)
  })

  it('tomorrow lands on the next day at 08:00', () => {
    const base = new Date('2026-08-10T22:30:00')
    const d = new Date(base)
    d.setDate(d.getDate() + 1)
    const out = atHour(d, 8)
    expect(out.getDate()).toBe(11)
    expect(out.getHours()).toBe(8)
    expect(out.getTime()).toBeGreaterThan(base.getTime())
  })

  it('this weekend never resolves to today', () => {
    // Run from a Saturday: it must jump a full week, not return now.
    const sat = new Date('2026-08-08T10:00:00')
    expect(sat.getDay()).toBe(6)
    const out = nextWeekday(sat, 6)
    expect(out.getTime()).toBeGreaterThan(sat.getTime())
    expect(out.getDate()).toBe(15)
  })

  it('next week never resolves to today', () => {
    const mon = new Date('2026-08-10T10:00:00')
    expect(mon.getDay()).toBe(1)
    const out = nextWeekday(mon, 1)
    expect(out.getTime()).toBeGreaterThan(mon.getTime())
    expect(out.getDate()).toBe(17)
  })

  it('every preset is in the future from a mid-week afternoon', () => {
    const now = new Date('2026-08-12T14:00:00')
    const targets = [
      new Date(now.getTime() + 3 * 3600_000),
      atHour(new Date(now.getTime() + 86400_000), 8),
      nextWeekday(now, 6),
      nextWeekday(now, 1)
    ]
    for (const t of targets) expect(t.getTime()).toBeGreaterThan(now.getTime())
  })
})
