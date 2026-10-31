/** What the renderer keeps per account from `sync:progress` events. */
export type SyncCounts = Record<string, { count: number; expected: number }>

interface ProgressEvent {
  phase: string
  email?: string
  count?: number
  expected?: number
}

/** Below this the pass is ordinary new mail: the quiet spinner is enough. */
const MIN_EXPECTED = 50

export function trackSync(prev: SyncCounts, p: ProgressEvent): SyncCounts {
  const key = p.email ?? ''
  if (p.phase === 'done' || p.phase === 'error') {
    if (!(key in prev)) return prev
    const { [key]: _gone, ...rest } = prev
    return rest
  }
  if (p.count == null || p.expected == null) return prev
  return { ...prev, [key]: { count: p.count, expected: p.expected } }
}

/** The top-bar progress: a first sync or a large catch-up, else null. */
export function syncBar(s: SyncCounts): { done: number; expected: number; pct: number } | null {
  let done = 0
  let expected = 0
  for (const v of Object.values(s)) {
    done += v.count
    expected += v.expected
  }
  if (expected < MIN_EXPECTED) return null
  return { done, expected, pct: Math.min(100, Math.round((done / expected) * 100)) }
}
