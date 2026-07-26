import type { ImapFlow } from 'imapflow'
import type { AccountConfig } from '../accounts/config.js'
import { createClient, moveUid } from './imap.js'

/**
 * Background IMAP MOVE. UI deletes/moves rows in SQLite first; this writes
 * the server move using the source path+uid captured at enqueue time
 * (because local uid is cleared after the optimistic move).
 */
interface Job {
  fromPath: string
  uid: number
  toPath: string
}

const IDLE_CLOSE_MS = 30_000

export class MoveWriter {
  private queue: Job[] = []
  private client: ImapFlow | null = null
  private running = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private config: AccountConfig) {}

  enqueue(job: Job): void {
    this.queue.push(job)
    void this.drain()
  }

  private async ensureClient(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client
    const client = createClient(this.config)
    await client.connect()
    this.client = client
    return client
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    if (this.idleTimer) clearTimeout(this.idleTimer)

    try {
      while (this.queue.length) {
        const job = this.queue.shift()!
        try {
          const client = await this.ensureClient()
          await moveUid(client, job.fromPath, job.uid, job.toPath)
        } catch {
          // Reconciled on next sync.
        }
      }
    } finally {
      this.running = false
      this.idleTimer = setTimeout(() => void this.close(), IDLE_CLOSE_MS)
    }
  }

  async close(): Promise<void> {
    const c = this.client
    this.client = null
    if (c) await c.logout().catch(() => {})
  }
}
