// One backfill per account at a time: Load older and the history worker share it.
const running = new Map<number, Promise<unknown>>()

/**
 * Runs `fn` as the account's only backfill. If one is already running, returns
 * null, or with `wait` waits for it to finish and then runs `fn`: the user's
 * Load older must not fail just because the history worker holds the account.
 */
export async function runBackfillExclusive<T>(
  accountId: number,
  fn: () => Promise<T>,
  opts: { wait?: boolean } = {}
): Promise<T | null> {
  for (let held = running.get(accountId); held; held = running.get(accountId)) {
    if (!opts.wait) return null
    await held.catch(() => {})
  }
  const p = fn()
  running.set(accountId, p)
  try {
    return await p
  } finally {
    if (running.get(accountId) === p) running.delete(accountId)
  }
}
