/** Superhuman's bar: an action slower than this on screen is a bug. */
export const ACTION_BUDGET_MS = 100

function defaultReport(name: string, ms: number): void {
  if (import.meta.env.DEV) {
    console.warn(`[perf] ${name} took ${ms.toFixed(1)}ms (budget ${ACTION_BUDGET_MS}ms)`)
  }
}

/** Runs fn and reports it when it overruns the budget. Never swallows errors. */
export async function timed<T>(
  name: string,
  fn: () => T | Promise<T>,
  opts: {
    budgetMs?: number
    now?: () => number
    report?: (name: string, ms: number) => void
  } = {}
): Promise<T> {
  const now = opts.now ?? (() => performance.now())
  const budget = opts.budgetMs ?? ACTION_BUDGET_MS
  const report = opts.report ?? defaultReport
  const start = now()
  try {
    return await fn()
  } finally {
    const ms = now() - start
    if (ms > budget) report(name, ms)
  }
}
