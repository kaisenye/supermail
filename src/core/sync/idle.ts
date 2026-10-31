import type { ImapFlow } from 'imapflow'
import type { AccountConfig } from '../accounts/config.js'
import { createClient } from './imap.js'

/**
 * Push notification for one mailbox. A dedicated connection sits in IDLE
 * (imapflow starts it automatically) and fires `onNewMail` instead of waiting
 * for the 60s poll. IMAP IDLE watches only the selected mailbox, so each
 * watched folder (INBOX, Sent) costs one parked connection. The poll stays as
 * the safety net if this never connects.
 */
const DEBOUNCE_MS = 1_000
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000]

export class IdleWatcher {
  private client: ImapFlow | null = null
  private stopped = false
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Bumped by restart and stop. A connect that started under an older value
   * has been overtaken (wake fires both 'resume' and 'online', often while a
   * token refresh is still pending) and must log its client out, not keep it.
   */
  private generation = 0

  constructor(
    private config: AccountConfig,
    readonly path: string,
    private onNewMail: () => void
  ) {}

  start(): void {
    if (this.client || this.reconnectTimer) return
    this.stopped = false
    void this.connect()
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    const gen = this.generation
    const stale = (): boolean => this.stopped || gen !== this.generation
    let client: ImapFlow
    try {
      client = await createClient(this.config)
    } catch {
      // No token (offline, or re-auth needed) — same backoff as a failed connect.
      if (!stale()) this.scheduleReconnect()
      return
    }
    if (stale()) {
      void client.logout().catch(() => {})
      return
    }
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
      await client.mailboxOpen(this.path)
      if (stale()) {
        if (this.client === client) this.client = null
        void client.logout().catch(() => {})
        return
      }
      this.attempt = 0
      // imapflow only starts IDLE after 15 s without a command; until then the
      // server holds back EXISTS, so mail arriving just after a (re)connect
      // would wait for the poll. Resolves when IDLE ends, so not awaited.
      void client.idle().catch(() => {})
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

  /**
   * Drops the connection and opens a fresh one now. After sleep or a network
   * change the old socket is often half-open: it looks connected, but no push
   * arrives until the OS gives up on it minutes later.
   */
  restart(): void {
    if (this.stopped) return
    this.generation++
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.attempt = 0
    const c = this.client
    // Cleared first, so the old socket's late 'close' schedules nothing.
    this.client = null
    if (c) void c.logout().catch(() => {})
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.generation++
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.reconnectTimer = null
    this.debounceTimer = null
    const c = this.client
    this.client = null
    if (c) void c.logout().catch(() => {})
  }
}

// One parked IDLE connection per account and mailbox: a shared watcher would
// leave every account but the first with no push at all.
const watchers = new Map<string, IdleWatcher>()

const accountKey = (email: string): string => `${email.toLowerCase()}\n`

/**
 * Watches `path` for `config`'s account under `role` (inbox, sent). A second
 * call for the same role is a no-op, unless the role's folder moved.
 */
export function watchMailbox(config: AccountConfig, role: string, path: string, onNewMail: () => void): void {
  const key = accountKey(config.email) + role
  const current = watchers.get(key)
  if (current?.path === path) return
  current?.stop()
  const w = new IdleWatcher(config, path, onNewMail)
  watchers.set(key, w)
  w.start()
}

/** INBOX push, which every account has from boot. */
export function startIdleWatcher(config: AccountConfig, onNewMail: () => void): void {
  watchMailbox(config, 'inbox', 'INBOX', onNewMail)
}

/** Every watcher reconnects now: after wake or a network change. */
export function restartIdleWatchers(): void {
  for (const w of watchers.values()) w.restart()
}

/** Stops one account's watchers, or every watcher when called with no argument. */
export function stopIdleWatcher(email?: string): void {
  for (const [k, w] of watchers) {
    if (email && !k.startsWith(accountKey(email))) continue
    w.stop()
    watchers.delete(k)
  }
}
