/**
 * Runs async reads where only the newest answer may land. A read started
 * earlier can resolve later (it was slower, or queued behind other IPC), and
 * applying it would paint a state older than one already on screen.
 */
export function latestOnly<T>(apply: (value: T) => void): (read: () => Promise<T>) => Promise<void> {
  let seq = 0
  return async (read) => {
    const mine = ++seq
    const value = await read()
    if (mine === seq) apply(value)
  }
}

/**
 * Tickets for one request at a time that can also be called off. `start()`
 * hands back a check that stays true only until the next `start()` or
 * `cancel()`, so a reply that lands after its view was closed or switched is
 * dropped instead of painted.
 */
export function requestGate(): { start: () => () => boolean; cancel: () => void } {
  let seq = 0
  return {
    start: () => {
      const mine = ++seq
      return () => mine === seq
    },
    cancel: () => {
      seq++
    }
  }
}
