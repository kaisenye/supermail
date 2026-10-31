import { describe, expect, it } from 'vitest'
import { SyncCounter } from './progress.js'

describe('SyncCounter', () => {
  it('expects new uids only: everything on a first sync, uidNext − 1 − last_uid after', () => {
    const c = new SyncCounter(
      [
        { id: 1, exists: 1_200, uidNext: 1_201, lastUid: 0 },
        // Old mail never stored locally (history off, or past the cap) is not "new".
        { id: 2, exists: 18_000, uidNext: 18_004, lastUid: 18_000 },
        { id: 3, exists: 30_000, uidNext: 30_001, lastUid: 0 }
      ],
      20_000
    )
    expect(c.expected).toBe(1_200 + 3 + 20_000)
    expect(c.done).toBe(0)
  })

  it('counts envelopes as they stream in, then the whole folder once it is done', () => {
    const c = new SyncCounter(
      [
        { id: 1, exists: 100, uidNext: 101, lastUid: 0 },
        { id: 2, exists: 40, uidNext: 41, lastUid: 0 }
      ],
      20_000
    )
    c.fetched(1, 30)
    expect(c.done).toBe(30)
    c.fetched(1, 60)
    expect(c.done).toBe(60)
    c.folderDone(1)
    expect(c.done).toBe(100)
    c.fetched(2, 500)
    expect(c.done).toBe(140)
    c.folderDone(2)
    expect(c.done).toBe(c.expected)
  })

  it('expects nothing from a folder whose uidNext is unknown', () => {
    expect(new SyncCounter([{ id: 1, exists: 500, uidNext: 0, lastUid: 400 }], 20_000).expected).toBe(0)
  })
})
