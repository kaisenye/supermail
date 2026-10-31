/**
 * One sync pass per account at a time. A request that arrives while a pass is
 * running (an IDLE push, often, landing after the pass already read INBOX) is
 * not dropped: `end` reports that one more pass is owed.
 *
 * `whenIdle(id)` lets that account's background work (body download) step
 * aside: parsing bodies on the main thread delays every network round trip of
 * a running pass, which made a pushed message take 20–30 s to appear during a
 * first body download. Other accounts' passes do not hold it back.
 */
export function createSyncGuard(): {
  begin(id: number): boolean
  end(id: number): boolean
  whenIdle(id: number): Promise<void>
} {
  const running = new Set<number>()
  const owed = new Set<number>()
  const waiters = new Map<number, (() => void)[]>()
  return {
    begin(id) {
      if (running.has(id)) {
        owed.add(id)
        return false
      }
      running.add(id)
      return true
    },
    end(id) {
      running.delete(id)
      const ready = waiters.get(id) ?? []
      waiters.delete(id)
      for (const w of ready) w()
      return owed.delete(id)
    },
    whenIdle(id) {
      if (!running.has(id)) return Promise.resolve()
      return new Promise<void>((r) => waiters.set(id, [...(waiters.get(id) ?? []), r]))
    }
  }
}
