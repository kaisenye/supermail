import type { ImapFlow } from 'imapflow'
import type { AccountConfig } from '../accounts/config.js'
import { processors } from '../pipeline/index.js'
import { runPipeline } from '../pipeline/pipeline.js'
import { getDb } from '../store/db.js'
import {
  deleteFolder,
  listFolders,
  oldestSyncedUid,
  resetFolder,
  setLastUid,
  upsertFolder,
  getSettings,
  setSetting
} from '../store/repo.js'
import {
  createClient,
  fetchEnvelopes,
  listMailboxes,
  mailboxStatus,
  ensureMessageIdFormat,
  parseReferences,
  type MailboxStatus
} from './imap.js'
import { reconcileFolder } from './reconcile.js'
import { rethreadAccount, type RethreadResult } from './rethread.js'
import type { RawMessage } from '../pipeline/types.js'

export interface SyncOptions {
  /** Cap per folder on the initial pass. */
  maxPerFolder?: number
  /** Skip messages older than this. */
  sinceDays?: number
  onProgress?: (p: SyncProgress) => void
  /** Message ids with an unflushed local flag write; reconcile leaves them alone. */
  pendingFlagIds?: Set<number>
}

export interface SyncProgress {
  phase: 'connect' | 'folders' | 'folder' | 'done' | 'error'
  folder?: string
  synced?: number
  total?: number
  error?: string
}

export interface SyncResult {
  folders: number
  messages: number
  /** Flags corrected from the server (read/unread/star changed elsewhere). */
  reconciled: number
  errors: { folder: string; message: string }[]
}

// Matches the widest window Exmail will expose over IMAP (its account-level
// retention setting), so the cutoff never discards mail the server offers.
const DEFAULTS = { maxPerFolder: 20000, sinceDays: 760 }

export async function syncAccount(
  accountId: number,
  config: AccountConfig,
  opts: SyncOptions = {}
): Promise<SyncResult> {
  const maxPerFolder = opts.maxPerFolder ?? DEFAULTS.maxPerFolder
  const sinceDays = opts.sinceDays ?? DEFAULTS.sinceDays
  const cutoff = Date.now() - sinceDays * 86_400_000
  const progress = opts.onProgress ?? (() => {})

  const pendingFlagIds = opts.pendingFlagIds ?? new Set<number>()
  const result: SyncResult = { folders: 0, messages: 0, reconciled: 0, errors: [] }
  const client: ImapFlow = createClient(config)

  progress({ phase: 'connect' })
  await client.connect()

  try {
    progress({ phase: 'folders' })
    const boxes = await listMailboxes(client)
    for (const b of boxes) {
      // \NoSelect entries are containers, not mailboxes.
      if (!b.selectable) continue
      if (isIgnoredFolder(b.path)) continue
      upsertFolder({ account_id: accountId, name: b.name, path: b.path, uidvalidity: null })
      result.folders++
    }

    // Clear out folders a previous sync stored before they were ignored.
    for (const f of listFolders(accountId)) {
      if (isIgnoredFolder(f.path)) deleteFolder(f.id)
    }

    // INBOX first so the primary view is usable before the rest finishes.
    const folders = listFolders(accountId).sort((a, b) =>
      a.path === 'INBOX' ? -1 : b.path === 'INBOX' ? 1 : 0
    )

    // Exmail has high per-command latency, so probe all folders concurrently
    // rather than paying that round-trip once per folder in sequence.
    const statuses = new Map<number, MailboxStatus>()
    await Promise.all(
      folders.map(async (f) => {
        try {
          statuses.set(f.id, await mailboxStatus(client, f.path))
        } catch {
          // Unreadable folder: fall through to the per-folder path, which
          // records the error properly.
        }
      })
    )

    for (const folder of folders) {
      progress({ phase: 'folder', folder: folder.path })
      try {
        // Skipping an unchanged folder avoids the SELECT round-trip, which
        // dominates sync wall-clock.
        const pre = statuses.get(folder.id) ?? (await mailboxStatus(client, folder.path))
        const noNewMail =
          folder.uidvalidity === pre.uidValidity && pre.uidNext <= folder.last_uid + 1

        // UIDNEXT only moves when mail ARRIVES, so it cannot tell us a message
        // was read, starred or deleted elsewhere — that needs a flags FETCH.
        // STATUS is far cheaper, so use it to decide when one is worth doing.
        const localCount = countLocal(folder.id)
        const localUnseen = countLocalUnseen(folder.id)
        const drifted = pre.unseen !== localUnseen || pre.exists !== localCount
        // Evaluate the timer unconditionally: it records when it last ran, and
        // short-circuiting past it would let that stamp go stale.
        const periodic = dueForFullReconcile(folder.id)
        if (drifted || periodic) {
          const rec = await reconcileFolder(client, folder.path, folder.id, {
            skipIds: pendingFlagIds,
            dropVanished: pre.exists < localCount
          })
          result.reconciled += rec.updated + rec.vanished
        }

        if (noNewMail) {
          progress({ phase: 'folder', folder: folder.path, synced: 0 })
          continue
        }

        const { status, messages } = await fetchEnvelopes(client, folder.path, {
          sinceUid: folder.last_uid,
          limit: maxPerFolder,
          accountId,
          folderId: folder.id
        })

        // UIDVALIDITY change means the server renumbered UIDs; cached rows are
        // meaningless and would surface as ghost/duplicate mail.
        if (folder.uidvalidity !== null && folder.uidvalidity !== status.uidValidity) {
          resetFolder(folder.id, status.uidValidity)
          const fresh = await fetchEnvelopes(client, folder.path, {
            sinceUid: 0,
            limit: maxPerFolder,
            accountId,
            folderId: folder.id
          })
          result.messages += await store(fresh.messages, cutoff)
          setLastUid(folder.id, maxUid(fresh.messages))
          progress({ phase: 'folder', folder: folder.path, synced: fresh.messages.length })
          continue
        }

        if (folder.uidvalidity === null) {
          getDb()
            .prepare('UPDATE folders SET uidvalidity = ? WHERE id = ?')
            .run(status.uidValidity, folder.id)
        }

        const n = await store(messages, cutoff)
        result.messages += n
        setLastUid(folder.id, maxUid(messages))
        progress({ phase: 'folder', folder: folder.path, synced: n })
      } catch (e) {
        result.errors.push({ folder: folder.path, message: (e as Error).message })
      }
    }

    progress({ phase: 'done', total: result.messages })
    return result
  } finally {
    await client.logout().catch(() => {})
  }
}

/**
 * Exmail's "other folders" tree (其他文件夹/...) is unused here, and syncing it
 * costs a STATUS round-trip per folder on every pass.
 */
const IGNORED_PREFIXES = ['其他文件夹']

/**
 * One-shot marker for the threading repair. Keyed per account so adding a new
 * one does not re-scan an account already fixed.
 */
function rethreadKey(accountId: number): string {
  return `account.${accountId}.rethreaded.v1`
}

export function rethreadDone(accountId: number): boolean {
  return getSettings()[rethreadKey(accountId)] === '1'
}

/**
 * One-time threading repair for mail synced before References was fetched.
 *
 * Deliberately outside syncAccount: it re-reads every header in the mailbox
 * (~5 min for 2k messages) and must not hold up the first paint. Runs on its
 * own connection, and only marks itself done after a clean pass.
 */
export async function repairThreading(
  accountId: number,
  config: AccountConfig
): Promise<RethreadResult & { skipped: boolean }> {
  if (rethreadDone(accountId)) return { scanned: 0, updated: 0, skipped: true }
  const client = createClient(config)
  await client.connect()
  try {
    const folders = listFolders(accountId).map((f) => ({ id: f.id, path: f.path }))
    const r = await rethreadAccount(client, accountId, folders)
    setSetting(rethreadKey(accountId), '1')
    return { ...r, skipped: false }
  } finally {
    await client.logout().catch(() => {})
  }
}

export function isIgnoredFolder(path: string): boolean {
  return IGNORED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
}

/** Stars and \Answered do not show up in STATUS, so sweep occasionally anyway. */
const FULL_RECONCILE_MS = 10 * 60_000
const lastReconcile = new Map<number, number>()

function dueForFullReconcile(folderId: number): boolean {
  const now = Date.now()
  const prev = lastReconcile.get(folderId) ?? 0
  if (now - prev < FULL_RECONCILE_MS) return false
  lastReconcile.set(folderId, now)
  return true
}

/** Local unseen count, mirroring the server's STATUS UNSEEN for comparison. */
function countLocalUnseen(folderId: number): number {
  return (
    getDb()
      .prepare(
        `SELECT count(*) c FROM messages m
         WHERE folder_id = ? AND uid IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM json_each(COALESCE(m.flags, '[]'))
             WHERE lower(json_each.value) = '\\seen'
           )`
      )
      .get(folderId) as { c: number }
  ).c
}

/** Null before the first sync has recorded one. */
function folderUidValidity(folderId: number): number | null {
  const row = getDb()
    .prepare('SELECT uidvalidity FROM folders WHERE id = ?')
    .get(folderId) as { uidvalidity: number | null } | undefined
  return row?.uidvalidity ?? null
}

/** Local row count for a folder — a drop vs the server's EXISTS means deletions. */
function countLocal(folderId: number): number {
  return (
    getDb()
      .prepare(
        'SELECT count(*) c FROM messages WHERE folder_id = ? AND uid IS NOT NULL'
      )
      .get(folderId) as { c: number }
  ).c
}

function maxUid(messages: { uid: number | null }[]): number {
  return messages.reduce((m, x) => Math.max(m, x.uid ?? 0), 0)
}

export interface BackfillResult {
  messages: number
  /** False once the oldest uid in the folder is already local. */
  more: boolean
}

/**
 * Fetches the page of mail immediately *older* than what is already synced.
 * The forward pass only ever asks for `uid > last_uid`, so without this the
 * initial 90-day/2000-message window is a permanent floor.
 */
export async function backfillFolder(
  accountId: number,
  config: AccountConfig,
  folder: { id: number; path: string },
  limit = 200
): Promise<BackfillResult> {
  const oldest = oldestSyncedUid(folder.id)
  // Nothing synced yet: the forward pass owns the first page, not this.
  if (oldest === null || oldest <= 1) return { messages: 0, more: false }

  const client: ImapFlow = createClient(config)
  await client.connect()
  try {
    const lock = await client.getMailboxLock(folder.path)
    try {
      const raw: RawMessage[] = []
      for await (const msg of client.fetch(
        `1:${oldest - 1}`,
        // Same header pull as the incremental path: ENVELOPE has no References
        // (RFC 3501), and without it backfilled mail cannot be threaded.
        { uid: true, envelope: true, flags: true, headers: ['references'] },
        { uid: true }
      )) {
        if (msg.uid >= oldest) continue
        raw.push({
          accountId,
          folderId: folder.id,
          uid: msg.uid,
          envelope: {
            messageId: msg.envelope?.messageId
              ? ensureMessageIdFormat(msg.envelope.messageId)
              : null,
            inReplyTo: msg.envelope?.inReplyTo
              ? ensureMessageIdFormat(msg.envelope.inReplyTo)
              : null,
            references: parseReferences(msg.headers),
            from: msg.envelope?.from?.[0]
              ? { address: msg.envelope.from[0].address, name: msg.envelope.from[0].name }
              : null,
            to: msg.envelope?.to?.map((a) => ({ address: a.address, name: a.name })) ?? [],
            cc: msg.envelope?.cc?.map((a) => ({ address: a.address, name: a.name })) ?? [],
            subject: msg.envelope?.subject ?? null,
            date: msg.envelope?.date ?? null
          },
          flags: msg.flags ? [...msg.flags] : []
        })
      }
      // Newest of the older block first, so a page walks steadily backwards.
      raw.sort((a, b) => (b.uid ?? 0) - (a.uid ?? 0))
      const page = raw.slice(0, limit)
      // Backfill is explicit user intent, so the sinceDays cutoff must not apply.
      const messages = await store(page, 0)
      return { messages, more: raw.length > page.length }
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => {})
  }
}

async function store(
  messages: Parameters<typeof runPipeline>[0][],
  cutoff: number
): Promise<number> {
  let n = 0
  for (const raw of messages) {
    const date = raw.envelope?.date
    if (date && date.getTime() < cutoff) continue
    const r = await runPipeline(raw, processors)
    if (r.id !== null) n++
  }
  return n
}

/**
 * Pulls new mail from one folder over an already-open connection.
 *
 * Used right after a send: IDLE only watches INBOX, so a message the server
 * files into Sent produces no push and would otherwise wait for the 60s
 * background poll. Reusing a pooled connection skips the ~2.8s login, leaving
 * roughly a SELECT plus a small FETCH.
 */
export async function refreshFolderNow(
  client: ImapFlow,
  accountId: number,
  folder: { id: number; path: string; last_uid: number },
  opts: { sinceDays?: number } = {}
): Promise<number> {
  const cutoff = Date.now() - (opts.sinceDays ?? DEFAULTS.sinceDays) * 86_400_000
  const { status, messages } = await fetchEnvelopes(client, folder.path, {
    sinceUid: folder.last_uid,
    limit: 50,
    accountId,
    folderId: folder.id
  })
  // A renumbered mailbox needs resetFolder + a full re-fetch; that is the full
  // sync's job. Bail rather than store UIDs against a stale uidvalidity.
  const known = folderUidValidity(folder.id)
  if (known !== null && known !== status.uidValidity) return 0
  if (!messages.length) return 0
  const n = await store(messages, cutoff)
  setLastUid(folder.id, maxUid(messages))
  return n
}
