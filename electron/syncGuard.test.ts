import { describe, expect, it } from 'vitest'
import { createSyncGuard } from './syncGuard.js'

describe('sync guard', () => {
  it('lets one pass run per account and asks for one more if a request came in meanwhile', () => {
    const g = createSyncGuard()
    expect(g.begin(1)).toBe(true)
    // A push lands while the pass is past INBOX: it must not be dropped.
    expect(g.begin(1)).toBe(false)
    expect(g.begin(1)).toBe(false)
    expect(g.begin(2)).toBe(true)
    expect(g.end(1)).toBe(true)
    // Only one follow-up, however many requests piled up.
    expect(g.begin(1)).toBe(true)
    expect(g.end(1)).toBe(false)
    expect(g.end(2)).toBe(false)
  })
  it('tells background work when no pass is running', async () => {
    const g = createSyncGuard()
    await g.whenIdle()
    g.begin(1)
    let resumed = false
    const wait = g.whenIdle().then(() => (resumed = true))
    await Promise.resolve()
    expect(resumed).toBe(false)
    g.end(1)
    await wait
    expect(resumed).toBe(true)
  })
})
