import { describe, expect, it } from 'vitest'
import { runBackfillExclusive } from './backfillLock.js'

describe('runBackfillExclusive', () => {
  it('returns null while the account is held, unless asked to wait', async () => {
    let release!: () => void
    const order: string[] = []
    const worker = runBackfillExclusive(1, async () => {
      await new Promise<void>((r) => (release = r))
      order.push('worker')
      return 'w'
    })
    expect(await runBackfillExclusive(1, async () => 'skip')).toBeNull()
    // Another account is not held.
    expect(await runBackfillExclusive(2, async () => 'other')).toBe('other')
    const user = runBackfillExclusive(
      1,
      async () => {
        order.push('user')
        return 'u'
      },
      { wait: true }
    )
    release()
    expect(await worker).toBe('w')
    expect(await user).toBe('u')
    expect(order).toEqual(['worker', 'user'])
  })

  it('waits out a page that throws, then runs', async () => {
    const failing = runBackfillExclusive(3, async () => {
      throw new Error('offline')
    })
    const user = runBackfillExclusive(3, async () => 'u', { wait: true })
    await expect(failing).rejects.toThrow('offline')
    expect(await user).toBe('u')
    expect(await runBackfillExclusive(3, async () => 'free')).toBe('free')
  })
})
