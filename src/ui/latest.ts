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
