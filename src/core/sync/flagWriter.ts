import type { ImapFlow } from 'imapflow'
import type { AccountConfig } from '../accounts/config.js'
import { getMessageLocation } from '../store/repo.js'
import { createClient, storeFlag } from './imap.js'

/**
 * Background flag write-back. The UI mutates SQLite first (instant), then
 * enqueues the IMAP write here. A single connection is reused and closed after
 * an idle period so repeated stars don't each pay a TLS handshake.
 */
interface Job {
  messageId: number
  flag: string
  add: boolean
}

const IDLE_CLOSE_MS = 30_000

export class FlagWriter {
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
        const loc = getMessageLocation(job.messageId)
        if (!loc) continue
        try {
          const client = await this.ensureClient()
          await storeFlag(client, loc.path, loc.uid, job.flag, job.add)
        } catch {
          // Local state already reflects the change; a failed write-back is
          // reconciled on the next full sync. Drop rather than block the queue.
        }
      }
    } finally {
      this.running = false
      // Close the connection if nothing new arrived while draining.
      this.idleTimer = setTimeout(() => void this.close(), IDLE_CLOSE_MS)
    }
  }

  async close(): Promise<void> {
    const c = this.client
    this.client = null
    if (c) await c.logout().catch(() => {})
  }
}
