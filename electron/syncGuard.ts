/**
 * One sync pass per account at a time. A request that arrives while a pass is
 * running (an IDLE push, often, landing after the pass already read INBOX) is
 * not dropped: `end` reports that one more pass is owed.
 *
 * `whenIdle` lets background work (body download) step aside: parsing bodies
 * on the main thread delays every network round trip of a running pass, which
 * made a pushed message take 20–30 s to appear during a first body download.
 */
export function createSyncGuard(): {
  begin(id: number): boolean
  end(id: number): boolean
  whenIdle(): Promise<void>
} {
  const running = new Set<number>()
  const owed = new Set<number>()
  let waiters: (() => void)[] = []
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
      if (!running.size) {
        const ready = waiters
        waiters = []
        for (const w of ready) w()
      }
      return owed.delete(id)
    },
    whenIdle() {
      return running.size ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve()
    }
  }
}
