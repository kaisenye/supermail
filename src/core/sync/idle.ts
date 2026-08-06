import type { ImapFlow } from 'imapflow'
import type { AccountConfig } from '../accounts/config.js'
import { createClient } from './imap.js'

/**
 * Push notification for new INBOX mail. A dedicated connection sits in IDLE
 * (imapflow starts it automatically) and fires `onNewMail` instead of waiting
 * for the 60s poll. The poll stays as the safety net if this never connects.
 */
const DEBOUNCE_MS = 1_000
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000]

export class IdleWatcher {
  private client: ImapFlow | null = null
  private stopped = false
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private config: AccountConfig,
    private onNewMail: () => void
  ) {}

  start(): void {
    if (this.client || this.reconnectTimer) return
    this.stopped = false
    void this.connect()
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    const client = createClient(this.config)
    this.client = client

    // Servers drop IDLE roughly every 29 min — a close is expected, not an error.
    client.on('close', () => {
      if (this.client === client) this.scheduleReconnect()
    })
    client.on('error', () => {})
    client.on('exists', () => this.fire())
    // The server also pushes untagged FETCH on a flag change and EXPUNGE on a
    // delete — that is how a read/star done in webmail reaches us in seconds.
    client.on('flags', () => this.fire())
    client.on('expunge', () => this.fire())

    try {
      await client.connect()
      await client.mailboxOpen('INBOX')
      this.attempt = 0
    } catch {
      // No IDLE support, bad creds, offline — back off and let the poll cover us.
      if (this.client === client) this.scheduleReconnect()
    }
  }

  /** Collapse a burst of `exists` events into one sync. */
  private fire(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      try {
        this.onNewMail()
      } catch {
        /* callback must never kill the watcher */
      }
    }, DEBOUNCE_MS)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const c = this.client
    this.client = null
    if (c) void c.logout().catch(() => {})

    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!
    this.attempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.reconnectTimer = null
    this.debounceTimer = null
    const c = this.client
    this.client = null
    if (c) void c.logout().catch(() => {})
  }
}

// One parked IDLE connection per account: a shared watcher would leave every
// account but the first with no push at all.
const watchers = new Map<string, IdleWatcher>()

export function startIdleWatcher(config: AccountConfig, onNewMail: () => void): void {
  const key = config.email.toLowerCase()
  if (watchers.has(key)) return
  const w = new IdleWatcher(config, onNewMail)
  watchers.set(key, w)
  w.start()
}

/** Stops one account's watcher, or every watcher when called with no argument. */
export function stopIdleWatcher(email?: string): void {
  const keys = email ? [email.toLowerCase()] : [...watchers.keys()]
  for (const k of keys) {
    watchers.get(k)?.stop()
    watchers.delete(k)
  }
}
