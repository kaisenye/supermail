/**
 * How long new mail takes to reach the local store, measured from the
 * server's INTERNALDATE (when it received the message) to the moment the
 * pipeline stored it. Uses the server's clock against ours, so skew shows up
 * as error; a server ahead of us reads as zero.
 */

/** Older than this, a message came from a first sync or backfill, not a push or poll. */
const FRESH_MS = 15 * 60_000
const KEEP = 100

let samples: number[] = []

/** Records one stored message; null when it is not new mail. */
export function noteArrival(receivedAt: Date | null | undefined, now = Date.now()): number | null {
  if (!receivedAt) return null
  const ms = Math.max(0, now - receivedAt.getTime())
  if (ms > FRESH_MS) return null
  samples.push(ms)
  if (samples.length > KEEP) samples = samples.slice(-KEEP)
  return ms
}

/** Nearest-rank percentiles over the last 100 arrivals. */
export function latencySummary(): { count: number; p50: number; p90: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0
  return { count: sorted.length, p50: at(0.5), p90: at(0.9) }
}

export function resetLatency(): void {
  samples = []
}
