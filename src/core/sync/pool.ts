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
      // ImapFlow is an EventEmitter: an unhandled 'error' — a socket timeout on
      // an idle pooled connection, most often — would crash the main process.
      // imapflow only self-recovers these while IDLE, which pooled ones never are.
      client.on('error', () => this.discard(entry))
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

  /**
   * Retires a connection the moment it fails. An in-flight lease keeps its
   * entry until release() so withConnection's own cleanup still runs.
   */
  private discard(entry: Entry): void {
    if (entry.busy) return // release() will retire it once the lease ends
    this.entries = this.entries.filter((e) => e !== entry)
    void entry.client.logout().catch(() => {})
    if (!this.closed) this.pumpWaiters()
  }

  private release(entry: Entry): void {
    entry.busy = false
    if (this.closed) return
    // Retiring a dead connection frees a slot, but the queued waiter is only
    // parked on a promise — without this it would wait forever for a lease
    // that can no longer be handed over.
    if (!entry.client.usable) {
      this.entries = this.entries.filter((e) => e !== entry)
      this.pumpWaiters()
      return
    }
    const next = this.waiters.shift()
    if (next) {
      entry.busy = true
      next(entry)
    }
  }

  /** Lets one parked waiter re-enter acquire() now that a slot is free. */
  private pumpWaiters(): void {
    const next = this.waiters.shift()
    if (!next) return
    void this.acquire().then(next, () => {
      // Reconnect failed; hand the slot to whoever is behind them.
      this.pumpWaiters()
    })
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

// Keyed by email: a single shared pool would hand out connections
// authenticated as whichever account happened to create it first.
const pools = new Map<string, ImapPool>()

export function getPool(config: AccountConfig): ImapPool {
  const key = config.email.toLowerCase()
  let p = pools.get(key)
  if (!p) {
    p = new ImapPool(config)
    pools.set(key, p)
  }
  return p
}

/** Closes one account's pool, or every pool when called with no argument. */
export async function closePool(email?: string): Promise<void> {
  const keys = email ? [email.toLowerCase()] : [...pools.keys()]
  const doomed: ImapPool[] = []
  for (const k of keys) {
    const p = pools.get(k)
    if (p) doomed.push(p)
    pools.delete(k)
  }
  await Promise.all(doomed.map((p) => p.close()))
}
