import type { AiErrorCode } from '../src/core/services/ai/types.js'

/** How long a rejected key or a provider rate limit holds the background queue. */
export const AI_PAUSE_MS = 10 * 60_000

/** The next local midnight: when the daily budget resets (see localDay). */
export function nextLocalMidnight(now: number): number {
  const d = new Date(now)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

/**
 * When a stopped background run may try again, or null to keep the normal tick.
 * 'auth' and 'rate' would fail the same way on every tick and each failure is a
 * real provider call; 'budget' cannot pass before the day turns over.
 */
export function pauseUntil(code: AiErrorCode | null, now: number): number | null {
  if (code === 'auth' || code === 'rate') return now + AI_PAUSE_MS
  if (code === 'budget') return nextLocalMidnight(now)
  return null
}

export interface AiPause {
  /** True while the queue should sit out ticks. Lifts on its own when the time passes. */
  paused(): boolean
  /** The code that paused the queue, or null. */
  reason(): AiErrorCode | null
  /** Records why a run stopped; pauses (and logs once) when that calls for it. */
  stopped(code: AiErrorCode | null): void
  /** A new key or new settings may fix the cause: run again on the next tick. */
  clear(): void
}

export function createAiPause(
  opts: { now?: () => number; log?: (msg: string) => void } = {}
): AiPause {
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((m: string) => console.warn(m))
  let until = 0
  let code: AiErrorCode | null = null
  const active = (): boolean => code !== null && now() < until
  return {
    paused: active,
    reason: () => (active() ? code : null),
    stopped(c) {
      const t = pauseUntil(c, now())
      if (t === null) return
      until = t
      code = c
      log(`[ai] background AI paused until ${new Date(t).toLocaleString()}: ${c}`)
    },
    clear() {
      until = 0
      code = null
    }
  }
}

export interface AiTickDeps<K extends string> {
  run(): Promise<{ done: { kind: K }[]; stopped: AiErrorCode | null }>
  /** Tells windows which kinds have new results. */
  notify(kinds: K[]): void
  pause: AiPause
  log?: (msg: string) => void
}

/**
 * One background AI tick: at most one run at a time, none while paused. A run
 * that stopped on a rejected key, a rate limit or the budget pauses the queue
 * instead of retrying the same failing call on every tick.
 */
export function createAiTick<K extends string>(deps: AiTickDeps<K>): () => Promise<void> {
  const log = deps.log ?? ((m: string) => console.error(m))
  let running = false
  return async () => {
    if (running || deps.pause.paused()) return
    running = true
    try {
      const r = await deps.run()
      if (r.done.length) deps.notify([...new Set(r.done.map((d) => d.kind))])
      deps.pause.stopped(r.stopped)
    } catch (e) {
      // The message is AiError-scrubbed or a local error: never the key.
      log(`[ai] worker run failed: ${(e as Error).message}`)
    } finally {
      running = false
    }
  }
}
