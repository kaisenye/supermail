import { beforeEach, describe, expect, it } from 'vitest'
import { latencySummary, noteArrival, resetLatency } from './latency.js'

const NOW = 1_000_000_000

beforeEach(() => resetLatency())

describe('arrival latency', () => {
  it('records how long after the server received it a message was stored', () => {
    expect(noteArrival(new Date(NOW - 1_500), NOW)).toBe(1_500)
    expect(latencySummary()).toEqual({ count: 1, p50: 1_500, p90: 1_500 })
  })

  it('ignores old mail, which a backfill or first sync stores', () => {
    expect(noteArrival(new Date(NOW - 20 * 60_000), NOW)).toBeNull()
    expect(noteArrival(null, NOW)).toBeNull()
    expect(latencySummary().count).toBe(0)
  })

  it('counts a server clock ahead of ours as zero, not negative', () => {
    expect(noteArrival(new Date(NOW + 2_000), NOW)).toBe(0)
  })

  it('reports the median and 90th percentile of recent arrivals', () => {
    for (const s of [1, 2, 3, 4, 5, 6, 7, 8, 9, 60]) noteArrival(new Date(NOW - s * 1_000), NOW)
    expect(latencySummary()).toEqual({ count: 10, p50: 5_000, p90: 9_000 })
  })
})
