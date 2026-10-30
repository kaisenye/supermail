import { describe, expect, it } from 'vitest'
import { latestOnly } from './latest'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('latestOnly', () => {
  it('applies a result', async () => {
    const seen: number[] = []
    const run = latestOnly<number>((v) => seen.push(v))
    await run(() => Promise.resolve(1))
    expect(seen).toEqual([1])
  })

  it('drops a result that a newer request has overtaken', async () => {
    // A refresh after a Remind me must not be overwritten by an older read
    // (taken before SQLite hid the thread) that happens to resolve later.
    const seen: number[] = []
    const run = latestOnly<number>((v) => seen.push(v))
    const older = deferred<number>()
    const newer = deferred<number>()
    const a = run(() => older.promise)
    const b = run(() => newer.promise)
    newer.resolve(37)
    older.resolve(38)
    await Promise.all([a, b])
    expect(seen).toEqual([37])
  })
})
