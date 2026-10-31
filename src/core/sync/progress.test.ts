import { describe, expect, it } from 'vitest'
import { SyncCounter } from './progress.js'

describe('SyncCounter', () => {
  it('expects what the server has beyond what is stored, capped per folder', () => {
    const c = new SyncCounter([
      { id: 1, exists: 1_200, local: 200 },
      { id: 2, exists: 50, local: 80 },
      { id: 3, exists: 30_000, local: 0 }
    ], 20_000)
    expect(c.expected).toBe(1_000 + 0 + 20_000)
    expect(c.done).toBe(0)
  })

  it('counts envelopes as they stream in, then the whole folder once it is done', () => {
    const c = new SyncCounter([{ id: 1, exists: 100, local: 0 }, { id: 2, exists: 40, local: 0 }], 20_000)
    c.fetched(1, 30)
    expect(c.done).toBe(30)
    c.fetched(1, 60)
    expect(c.done).toBe(60)
    // The cutoff can drop some, so a finished folder counts in full.
    c.folderDone(1)
    expect(c.done).toBe(100)
    c.fetched(2, 500)
    expect(c.done).toBe(140)
    c.folderDone(2)
    expect(c.done).toBe(c.expected)
  })
})
