import type { ImapFlow } from 'imapflow'
import type { AccountConfig } from '../accounts/config.js'
import { listMailboxes, moveUid } from './imap.js'
import { getPool } from './pool.js'

/**
 * Background IMAP MOVE. UI deletes/moves rows in SQLite first; this writes
 * the server move using the source path+uid captured at enqueue time
 * (because local uid is cleared after the optimistic move).
 */
interface Job {
  fromPath: string
  uid: number
  toPath: string
  attempt?: number
}

/** Signals an unreachable destination, which retrying cannot fix. */
class MissingMailbox extends Error {}

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

export class MoveWriter {
  private queue: Job[] = []
  private running = false
  private paths: Set<string> | null = null

  constructor(private config: AccountConfig) {}

  enqueue(job: Job): void {
    this.queue.push(job)
    void this.drain()
  }

  /** Cached; a miss re-lists once in case the folder was created after boot. */
  private async mailboxExists(client: ImapFlow, path: string): Promise<boolean> {
    if (this.paths?.has(path)) return true
    const boxes = await listMailboxes(client)
    this.paths = new Set(boxes.filter((b) => b.selectable).map((b) => b.path))
    return this.paths.has(path)
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true

    try {
      while (this.queue.length) {
        const job = this.queue.shift()!
        try {
          await getPool(this.config).withConnection(async (client) => {
            // The caller can hand us a path that doesn't exist on the server;
            // moving into it would lose the message.
            if (!(await this.mailboxExists(client, job.toPath))) {
              throw new MissingMailbox(job.toPath)
            }
            await moveUid(client, job.fromPath, job.uid, job.toPath)
          })
        } catch (err) {
          if (err instanceof MissingMailbox) {
            console.error(
              `[moveWriter] destination mailbox "${job.toPath}" does not exist — ${job.fromPath}:${job.uid} left in place`
            )
            continue
          }
          const attempt = (job.attempt ?? 0) + 1
          if (isPermanent(err) || attempt >= MAX_ATTEMPTS) {
            // Incremental sync never re-reads this uid, so the move is lost
            // unless we say so here.
            console.error(
              `[moveWriter] gave up moving ${job.fromPath}:${job.uid} to ${job.toPath} after ${attempt} attempt(s):`,
              err
            )
            continue
          }
          // Re-queue at the tail so a failing job never blocks the rest.
          this.queue.push({ ...job, attempt })
          await delay(RETRY_BASE_MS * 2 ** (attempt - 1))
        }
      }
    } finally {
      this.running = false
    }
  }

}
