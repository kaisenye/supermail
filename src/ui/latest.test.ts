import { describe, expect, it } from 'vitest'
import { latestOnly, requestGate } from './latest'

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

describe('requestGate', () => {
  it('keeps a request current until another starts', () => {
    const gate = requestGate()
    const q1 = gate.start()
    expect(q1()).toBe(true)
    const q2 = gate.start()
    expect(q1()).toBe(false)
    expect(q2()).toBe(true)
  })

  it('drops a request that was cancelled, as when the palette closes mid-ask', async () => {
    const gate = requestGate()
    const seen: string[] = []
    const reply = deferred<string>()
    const ask = async (): Promise<void> => {
      const current = gate.start()
      const r = await reply.promise
      if (current()) seen.push(r)
    }
    const pending = ask()
    gate.cancel()
    reply.resolve('Q1 answer')
    await pending
    expect(seen).toEqual([])
  })
})
