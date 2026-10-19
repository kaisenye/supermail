import { describe, expect, it } from 'vitest'
import { timed } from './perf.js'

/** A clock that returns the given ticks in order, then sticks on the last. */
function clock(...ticks: number[]): () => number {
  let i = 0
  return () => ticks[Math.min(i++, ticks.length - 1)]
}

describe('timed', () => {
  it('reports an action over budget', async () => {
    const seen: [string, number][] = []
    const out = await timed('msg.trash', () => 'ok', {
      now: clock(0, 150),
      report: (n, ms) => seen.push([n, ms])
    })
    expect(out).toBe('ok')
    expect(seen).toEqual([['msg.trash', 150]])
  })

  it('stays quiet under budget', async () => {
    const seen: unknown[] = []
    await timed('nav.down', () => undefined, { now: clock(0, 40), report: () => seen.push(1) })
    expect(seen).toEqual([])
  })

  it('still reports, and rethrows, when the action fails', async () => {
    const seen: unknown[] = []
    await expect(
      timed(
        'x',
        () => {
          throw new Error('boom')
        },
        { now: clock(0, 500), report: () => seen.push(1) }
      )
    ).rejects.toThrow('boom')
    expect(seen).toHaveLength(1)
  })
})
