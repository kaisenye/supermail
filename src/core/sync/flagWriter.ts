import type { AccountConfig } from '../accounts/config.js'
import { getMessageLocation } from '../store/repo.js'
import { storeFlag } from './imap.js'
import { getPool } from './pool.js'

/**
 * Background flag write-back. The UI mutates SQLite first (instant), then
 * enqueues the IMAP write here, which runs on a pooled connection so a star
 * never pays a TLS handshake.
 */
interface Job {
  messageId: number
  flag: string
  add: boolean
  attempt?: number
}

const MAX_ATTEMPTS = 4
const RETRY_BASE_MS = 1_000

/** A NO/BAD reply means the server rejected the command — retrying can't help. */
function isPermanent(err: unknown): boolean {
  const status = (err as { responseStatus?: string } | null)?.responseStatus
  return status === 'NO' || status === 'BAD'
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export class FlagWriter {
  private queue: Job[] = []
  private running = false
  private inFlight: number | null = null

  constructor(private config: AccountConfig) {}

  enqueue(job: Job): void {
    this.queue.push(job)
    void this.drain()
  }

  /**
   * Message ids with a local flag change not yet on the server. Reconcile must
   * skip these or it would overwrite the user's change with stale server state.
   */
  pendingIds(): Set<number> {
    const ids = new Set(this.queue.map((j) => j.messageId))
    if (this.inFlight !== null) ids.add(this.inFlight)
    return ids
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true

    try {
      while (this.queue.length) {
        const job = this.queue.shift()!
        // Shifted off the queue but not yet written — still pending for reconcile.
        this.inFlight = job.messageId
        const loc = getMessageLocation(job.messageId)
        if (!loc) {
          this.inFlight = null
          continue
        }
        try {
          await getPool(this.config).withConnection((client) =>
            storeFlag(client, loc.path, loc.uid, job.flag, job.add)
          )
        } catch (err) {
          const attempt = (job.attempt ?? 0) + 1
          if (isPermanent(err) || attempt >= MAX_ATTEMPTS) {
            // Incremental sync never re-reads this uid, so the server stays
            // wrong while SQLite claims success. Surface it.
            console.error(
              `[flagWriter] gave up ${job.add ? '+' : '-'}${job.flag} on ${loc.path}:${loc.uid} after ${attempt} attempt(s):`,
              err
            )
            continue
          }
          // Re-queue at the tail so a failing job never blocks the rest.
          this.queue.push({ ...job, attempt })
          await delay(RETRY_BASE_MS * 2 ** (attempt - 1))
        } finally {
          this.inFlight = null
        }
      }
    } finally {
      this.running = false
    }
  }

}
