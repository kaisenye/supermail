import type { ImapFlow } from 'imapflow'
import type { AccountConfig } from '../accounts/config.js'
import { deleteMoveJob, insertMoveJob, listMoveJobs } from '../store/moveJobs.js'
import { listMailboxes, moveUid } from './imap.js'
import { getPool } from './pool.js'

/**
 * Background IMAP MOVE. The UI moves rows in SQLite first; this writes the
 * server move using the source path+uid captured at enqueue time (the local
 * uid is cleared by the optimistic move).
 *
 * Every job is on disk before it runs and deleted once it settles, so a quit,
 * crash or offline spell is replayed by resume() rather than lost. Replay is
 * safe: a UID MOVE of a uid that already left the mailbox is a no-op.
 */
export interface MoveRequest {
  fromPath: string
  uid: number
  toPath: string
}

export type MoveFn = (job: MoveRequest) => Promise<void>

interface Job extends MoveRequest {
  rowId: number
  attempt: number
}

/** Signals an unreachable destination, which retrying cannot fix. */
export class MissingMailbox extends Error {}

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
  private draining: Promise<void> | null = null
  private paths: Set<string> | null = null
  private move: MoveFn
  private retryBaseMs: number

  constructor(
    private accountId: number,
    private config: AccountConfig,
    opts: { move?: MoveFn; retryBaseMs?: number } = {}
  ) {
    this.move = opts.move ?? ((job) => this.imapMove(job))
    this.retryBaseMs = opts.retryBaseMs ?? RETRY_BASE_MS
  }

  enqueue(job: MoveRequest): void {
    const rowId = insertMoveJob({
      account_id: this.accountId,
      from_path: job.fromPath,
      uid: job.uid,
      to_path: job.toPath
    })
    this.queue.push({ ...job, rowId, attempt: 0 })
    void this.drain()
  }

  /** Re-queues every persisted job not already queued, with a fresh retry budget. */
  resume(): void {
    const queued = new Set(this.queue.map((j) => j.rowId))
    for (const r of listMoveJobs(this.accountId)) {
      if (queued.has(r.id)) continue
      this.queue.push({
        rowId: r.id,
        fromPath: r.from_path,
        uid: r.uid,
        toPath: r.to_path,
        attempt: 0
      })
    }
    void this.drain()
  }

  /** Resolves once the queue is empty. */
  async whenIdle(): Promise<void> {
    while (this.draining) await this.draining
  }

  private drain(): Promise<void> {
    if (!this.draining) {
      this.draining = this.run().finally(() => {
        this.draining = null
        // A job enqueued while run() was finishing would otherwise wait for
        // the next enqueue.
        if (this.queue.length) void this.drain()
      })
    }
    return this.draining
  }

  private async run(): Promise<void> {
    while (this.queue.length) {
      const job = this.queue.shift()!
      try {
        await this.move({ fromPath: job.fromPath, uid: job.uid, toPath: job.toPath })
        deleteMoveJob(job.rowId)
      } catch (err) {
        if (err instanceof MissingMailbox) {
          console.error(
            `[moveWriter] destination mailbox "${job.toPath}" does not exist — ${job.fromPath}:${job.uid} left in place`
          )
          deleteMoveJob(job.rowId)
          continue
        }
        if (isPermanent(err)) {
          console.error(
            `[moveWriter] server rejected moving ${job.fromPath}:${job.uid} to ${job.toPath}:`,
            err
          )
          deleteMoveJob(job.rowId)
          continue
        }
        const attempt = job.attempt + 1
        if (attempt >= MAX_ATTEMPTS) {
          // Most likely offline. The row stays on disk; resume() retries it
          // after the next successful sync or at the next launch.
          console.error(
            `[moveWriter] deferring ${job.fromPath}:${job.uid} -> ${job.toPath} after ${attempt} attempt(s):`,
            err
          )
          continue
        }
        // Re-queue at the tail so a failing job never blocks the rest.
        this.queue.push({ ...job, attempt })
        await delay(this.retryBaseMs * 2 ** (attempt - 1))
      }
    }
  }

  /** Cached; a miss re-lists once in case the folder was created after boot. */
  private async mailboxExists(client: ImapFlow, path: string): Promise<boolean> {
    if (this.paths?.has(path)) return true
    const boxes = await listMailboxes(client)
    this.paths = new Set(boxes.filter((b) => b.selectable).map((b) => b.path))
    return this.paths.has(path)
  }

  private imapMove(job: MoveRequest): Promise<void> {
    return getPool(this.config).withConnection(async (client) => {
      // Moving into a mailbox that doesn't exist would lose the message.
      if (!(await this.mailboxExists(client, job.toPath))) throw new MissingMailbox(job.toPath)
      await moveUid(client, job.fromPath, job.uid, job.toPath)
    })
  }
}
