import type { ImapFlow } from 'imapflow'
import type { AccountConfig } from '../accounts/config.js'
import { createClient } from './imap.js'

/**
 * Shared pool of authenticated IMAP connections.
 *
 * Connecting to Exmail costs ~2.7s (TLS + greeting + LOGIN) and selecting a
 * mailbox another ~0.8s, while the actual work — a flag write — is ~250ms.
 * Every subsystem used to open its own connection and drop it after 30s idle,
 * so most actions paid the setup cost instead of amortising it.
 *
 * Connections are kept alive with periodic NOOP. Mailbox selection is left to
 * imapflow's getMailboxLock inside each operation: it already no-ops when the
 * mailbox is current, and it is the only thing that knows what a nested helper
 * selected. Caching it here would go stale the moment an operation locked a
 * different mailbox — and a UID resolved against the wrong mailbox moves the
 * wrong message.
 *
 * The IDLE watcher deliberately stays outside this pool: it must sit parked on
 * its own connection and can never be lent out.
 */

/** Exmail accepted 8+ concurrent; 3 leaves headroom for IDLE and SMTP. */
const MAX_CONNECTIONS = 3

/** Well inside the ~29 min the server will hold an idle connection. */
const KEEPALIVE_MS = 4 * 60_000

interface Entry {
  client: ImapFlow
  busy: boolean
}

export class ImapPool {
  private entries: Entry[] = []
  private waiters: ((e: Entry) => void)[] = []
  private keepalive: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(private config: AccountConfig) {}

  /**
   * Runs `fn` on a pooled connection. Callers select their own mailbox via
   * getMailboxLock, which serialises concurrent leases on the same connection
   * and skips the SELECT when it is already current.
   */
  async withConnection<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const entry = await this.acquire()
    try {
      return await fn(entry.client)
    } catch (err) {
      // A dead connection must never go back into the pool.
      if (!entry.client.usable) {
        this.entries = this.entries.filter((e) => e !== entry)
        void entry.client.logout().catch(() => {})
      }
      throw err
    } finally {
      this.release(entry)
    }
  }

  private async acquire(): Promise<Entry> {
    if (this.closed) throw new Error('pool closed')

    const free = this.entries.find((e) => !e.busy && e.client.usable)
    if (free) {
      free.busy = true
      return free
    }

    // Drop anything the server hung up on before deciding we are at capacity.
    this.entries = this.entries.filter((e) => e.client.usable || e.busy)

    if (this.entries.length < MAX_CONNECTIONS) {
      const client = createClient(this.config)
      const entry: Entry = { client, busy: true }
      this.entries.push(entry)
      try {
        await client.connect()
      } catch (err) {
        this.entries = this.entries.filter((e) => e !== entry)
        throw err
      }
      this.startKeepalive()
      return entry
    }

    return new Promise<Entry>((resolve) => this.waiters.push(resolve))
  }

  private release(entry: Entry): void {
    if (this.closed || !entry.client.usable) {
      entry.busy = false
      return
    }
    const next = this.waiters.shift()
    if (next) {
      next(entry)
      return
    }
    entry.busy = false
  }

  /** NOOP keeps the server from reaping connections we are holding open. */
  private startKeepalive(): void {
    if (this.keepalive) return
    this.keepalive = setInterval(() => {
      for (const e of this.entries) {
        if (e.busy || !e.client.usable) continue
        void e.client.noop().catch(() => {})
      }
    }, KEEPALIVE_MS)
    this.keepalive.unref?.()
  }

  /**
   * Opens one connection ahead of demand. Without this the first user action
   * after launch pays the full ~4.7s connect; the app is idle at boot anyway.
   */
  async warm(): Promise<void> {
    try {
      await this.withConnection(async () => {})
    } catch {
      // Offline or bad creds — the next real action will surface it properly.
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.keepalive) clearInterval(this.keepalive)
    this.keepalive = null
    const all = this.entries
    this.entries = []
    await Promise.all(all.map((e) => e.client.logout().catch(() => {})))
  }
}

let pool: ImapPool | null = null

export function getPool(config: AccountConfig): ImapPool {
  if (!pool) pool = new ImapPool(config)
  return pool
}

export async function closePool(): Promise<void> {
  const p = pool
  pool = null
  if (p) await p.close()
}
