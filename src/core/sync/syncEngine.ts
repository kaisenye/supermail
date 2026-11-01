import type { ImapFlow } from 'imapflow'
import type { AccountConfig } from '../accounts/config.js'
import { processors } from '../pipeline/index.js'
import { runPipeline } from '../pipeline/pipeline.js'
import { latencySummary, noteArrival } from './latency.js'
import { SyncCounter } from './progress.js'
import { getDb } from '../store/db.js'
import { queuedSourceUids } from '../store/moveJobs.js'
import { assignRoles } from '../store/folderRoles.js'
import {
  deleteFolder,
  listFolders,
  newestSyncedUid,
  resetFolder,
  setFolderRoles,
  setLastUid,
  upsertFolder,
  getSettings,
  setSetting,
  reopenHistory
} from '../store/repo.js'
import {
  createClient,
  fetchEnvelopes,
  listMailboxes,
  mailboxStatus,
  ENVELOPE_QUERY,
  envelopeToRaw,
  type MailboxStatus
} from './imap.js'
import { shouldSyncFolder } from './folderFilter.js'
import { gmailSearchUids, liveUidValidity, missingUids } from './serverSearch.js'
import { reconcileFolder } from './reconcile.js'
import { rethreadAccount, type RethreadResult } from './rethread.js'
import { backfillListHeaders, type HeaderBackfillResult } from './headerBackfill.js'
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
  /** Which account; several can sync at once (IDLE pushes, history). */
  email?: string
  folder?: string
  /** Messages synced so far this pass, of `expected` (see SyncCounter). */
  count?: number
  expected?: number
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

/**
 * The forward pass's date floor. With full offline history on (the default)
 * there is none: mail with an old date can still arrive under a new uid (an
 * archived message moved back into INBOX), and dropping it while last_uid moves
 * past it would lose it for good once the folder's history is complete.
 */
export function forwardCutoff(sinceDays: number, now = Date.now()): number {
  if (getSettings().full_history !== '0') return 0
  return now - sinceDays * 86_400_000
}

/**
 * Highest uid backfill must cover. last_uid counts too: the forward pass can
 * move it past mail it skipped, and those uids are still missing locally.
 */
export function backfillCeiling(newestLocal: number | null, lastUid: number): number | null {
  const c = Math.max(newestLocal ?? 0, lastUid)
  return c > 0 ? c : null
}

export async function syncAccount(
  accountId: number,
  config: AccountConfig,
  opts: SyncOptions = {}
): Promise<SyncResult> {
  const maxPerFolder = opts.maxPerFolder ?? DEFAULTS.maxPerFolder
  const sinceDays = opts.sinceDays ?? DEFAULTS.sinceDays
  const cutoff = forwardCutoff(sinceDays)
  const emit = opts.onProgress ?? (() => {})
  const progress = (p: SyncProgress): void => emit({ ...p, email: config.email })

  const pendingFlagIds = opts.pendingFlagIds ?? new Set<number>()
  const result: SyncResult = { folders: 0, messages: 0, reconciled: 0, errors: [] }
  const client: ImapFlow = await createClient(config)

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

    // SPECIAL-USE where the server offers it (Gmail, Outlook), names otherwise
    // (Exmail). Recomputed every pass so a renamed folder cannot keep a role.
    // An empty result (odd LIST reply) must not wipe the roles we already have.
    const roles = assignRoles(boxes.filter((b) => b.selectable && !isIgnoredFolder(b.path)))
    if (roles.size) setFolderRoles(accountId, roles)

    // Clear out folders a previous sync stored before they were ignored.
    for (const f of listFolders(accountId)) {
      if (isIgnoredFolder(f.path)) deleteFolder(f.id)
    }

    // INBOX first so the primary view is usable before the rest finishes.
    const folders = listFolders(accountId)
      .filter((f) => shouldSyncFolder(config.provider, f))
      .sort((a, b) => (a.role === 'inbox' ? -1 : b.role === 'inbox' ? 1 : 0))

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

    const counter = new SyncCounter(
      folders.map((f) => ({
        id: f.id,
        exists: statuses.get(f.id)?.exists ?? 0,
        uidNext: statuses.get(f.id)?.uidNext ?? 0,
        lastUid: f.last_uid
      })),
      maxPerFolder
    )
    const counted = (folder: string): SyncProgress => ({
      phase: 'folder',
      folder,
      count: counter.done,
      expected: counter.expected
    })
    // Envelopes stream in by the hundred; the window only needs a few frames a second.
    let lastEmit = 0
    const streaming = (folder: { id: number; path: string }) => (n: number) => {
      counter.fetched(folder.id, n)
      const now = Date.now()
      if (now - lastEmit < 150) return
      lastEmit = now
      progress(counted(folder.path))
    }

    for (const folder of folders) {
      progress(counted(folder.path))
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
            dropVanished: pre.exists < localCount,
            labelsAccountId: config.provider === 'gmail' ? accountId : undefined
          })
          result.reconciled += rec.updated + rec.vanished
        }

        if (noNewMail) {
          counter.folderDone(folder.id)
          progress({ ...counted(folder.path), synced: 0 })
          continue
        }

        const { status, messages } = await fetchEnvelopes(client, folder.path, {
          sinceUid: folder.last_uid,
          limit: maxPerFolder,
          accountId,
          folderId: folder.id,
          onFetched: streaming(folder)
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
          result.messages += await store(fresh.messages, cutoff, false)
          setLastUid(folder.id, maxUid(fresh.messages))
          counter.folderDone(folder.id)
          progress({ ...counted(folder.path), synced: fresh.messages.length })
          continue
        }

        if (folder.uidvalidity === null) {
          getDb()
            .prepare('UPDATE folders SET uidvalidity = ? WHERE id = ?')
            .run(status.uidValidity, folder.id)
        }

        const n = await store(messages, cutoff, folder.last_uid > 0)
        result.messages += n
        setLastUid(folder.id, maxUid(messages))
        counter.folderDone(folder.id)
        progress({ ...counted(folder.path), synced: n })
      } catch (e) {
        counter.folderDone(folder.id)
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
  const client = await createClient(config)
  await client.connect()
  try {
    const folders = listFolders(accountId)
      .filter((f) => shouldSyncFolder(config.provider, f))
      .map((f) => ({ id: f.id, path: f.path }))
    const r = await rethreadAccount(client, accountId, folders)
    setSetting(rethreadKey(accountId), '1')
    return { ...r, skipped: false }
  } finally {
    await client.logout().catch(() => {})
  }
}

function listHeadersKey(accountId: number): string {
  return `account.${accountId}.listHeaders.v1`
}

export function listHeadersDone(accountId: number): boolean {
  return getSettings()[listHeadersKey(accountId)] === '1'
}

/**
 * One-time list-header backfill for mail synced before migration v18, so old
 * newsletters land in Other and can be unsubscribed. Same shape as
 * repairThreading: own connection, headers only, marked done after a clean pass.
 */
export async function repairListHeaders(
  accountId: number,
  config: AccountConfig
): Promise<HeaderBackfillResult & { skipped: boolean }> {
  if (listHeadersDone(accountId)) return { scanned: 0, updated: 0, skipped: true }
  const client = await createClient(config)
  await client.connect()
  try {
    const folders = listFolders(accountId)
      .filter((f) => shouldSyncFolder(config.provider, f))
      .map((f) => ({ id: f.id, path: f.path }))
    const r = await backfillListHeaders(client, accountId, folders)
    setSetting(listHeadersKey(accountId), '1')
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
  /** False once every server uid at or below the newest local one is local. */
  more: boolean
}

/**
 * Fetches the newest page of server mail missing locally, at or below the
 * newest synced uid. The forward pass only ever asks for `uid > last_uid`, so
 * without this the initial 90-day/2000-message window is a permanent floor.
 *
 * Gap-aware rather than "everything below min(uid)": server search stores old
 * hits far below the synced window, and paging from the lowest local uid would
 * skip every uid between that hit and the window for good.
 */
export async function backfillFolder(
  accountId: number,
  config: AccountConfig,
  folder: { id: number; path: string; uidvalidity: number | null; last_uid: number },
  limit = 200,
  /** Source uids of moves still held for undo; the server has them here until the MOVE runs. */
  held: () => Iterable<number> = () => []
): Promise<BackfillResult> {
  // The forward pass can skip mail (the sinceDays window when full history is
  // off) yet still advance last_uid over everything it fetched, so search up to
  // whichever is higher: a folder of nothing but old mail has no local rows yet
  // a last_uid, and skipped uids above the newest local row are still missing.
  const ceiling = backfillCeiling(newestSyncedUid(folder.id), folder.last_uid)
  // Forward pass never ran here: it owns the first page, not this.
  if (ceiling === null) return { messages: 0, more: false }

  const client: ImapFlow = await createClient(config)
  await client.connect()
  try {
    const lock = await client.getMailboxLock(folder.path)
    try {
      // Renumbered (or never stamped) since the last forward sync: local uids
      // no longer name these messages, and an upsert would land on rows that
      // belong to others. The next forward sync resets the folder; until then
      // report more so nobody marks the history complete.
      if (folder.uidvalidity == null || liveUidValidity(client) !== folder.uidvalidity)
        return { messages: 0, more: true }
      const onServer = (await client.search({ uid: `1:${ceiling}` }, { uid: true })) || []
      const skip = () => new Set<number>([...held(), ...queuedSourceUids(accountId, folder.path)])
      const plan = backfillPlan(folder.id, onServer, skip(), limit)
      if (!plan.uids.length) return { messages: 0, more: plan.more }
      const raw: RawMessage[] = []
      // Same query as the incremental path: ENVELOPE has no References
      // (RFC 3501), and without it backfilled mail cannot be threaded.
      for await (const msg of client.fetch(plan.uids.join(','), ENVELOPE_QUERY, { uid: true })) {
        raw.push(envelopeToRaw(msg, accountId, folder.id))
      }
      // Re-read after the fetch, so a move made while it ran is skipped too.
      const { page } = backfillPage(raw, skip(), limit)
      // Backfill is explicit user intent, so the sinceDays cutoff must not apply.
      const messages = await store(page, 0, false)
      return { messages, more: plan.more }
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => {})
  }
}

/**
 * Which server uids the next backfill page fetches: those with no local row in
 * the folder, newest first, at most `limit`. Holes anywhere count, including
 * ones above a low uid that server search stored.
 */
export function backfillPlan(
  folderId: number,
  serverUids: number[],
  skip: Iterable<number>,
  limit: number
): { uids: number[]; more: boolean } {
  const missing = missingUids(folderId, serverUids, Infinity, skip)
  return { uids: missing.slice(0, limit), more: missing.length > limit }
}

/**
 * The next older page, newest first so paging walks steadily backwards.
 * Messages mid-move are skipped: their local row has a NULL uid (so they look
 * missing to backfillPlan), and storing them again would duplicate them in the
 * folder they are leaving.
 */
export function backfillPage<T extends { uid?: number | null }>(
  raw: T[],
  skip: ReadonlySet<number>,
  limit: number
): { page: T[]; more: boolean } {
  const fresh = raw.filter((m) => m.uid == null || !skip.has(m.uid))
  fresh.sort((a, b) => (b.uid ?? 0) - (a.uid ?? 0))
  const page = fresh.slice(0, limit)
  return { page, more: fresh.length > page.length }
}

/**
 * Fetches and stores the given uids (server-search hits) over an open
 * connection. Same envelope query as every other path, so they thread. The
 * sinceDays window does not apply: the user asked for them. Stores nothing if
 * the mailbox's UIDVALIDITY is no longer `uidValidity`: the uids would land on
 * rows that belong to other messages.
 */
export async function fetchUids(
  client: ImapFlow,
  accountId: number,
  folder: { id: number; path: string },
  uids: number[],
  uidValidity: number
): Promise<number> {
  if (!uids.length) return 0
  const raw: RawMessage[] = []
  const lock = await client.getMailboxLock(folder.path)
  try {
    if (liveUidValidity(client) !== uidValidity) return 0
    for await (const msg of client.fetch(uids.join(','), ENVELOPE_QUERY, { uid: true })) {
      raw.push(envelopeToRaw(msg, accountId, folder.id))
    }
  } finally {
    lock.release()
  }
  return store(raw, 0, false)
}

/**
 * Gmail server search in one folder: X-GM-RAW, then store up to `limit` hits
 * with no local row. Skips the folder when its UIDVALIDITY is unknown or has
 * changed since the last sync: local uids would be compared against, and
 * overwritten by, a renumbered mailbox. The next full sync resets it.
 */
export async function serverSearchFolder(
  client: ImapFlow,
  accountId: number,
  folder: { id: number; path: string; uidvalidity: number | null },
  raw: string,
  skip: Iterable<number>,
  limit = 50
): Promise<number> {
  const hits = await gmailSearchUids(client, folder.path, raw)
  if (folder.uidvalidity == null || folder.uidvalidity !== hits.uidValidity) return 0
  const want = missingUids(folder.id, hits.uids, limit, skip)
  return fetchUids(client, accountId, folder, want, hits.uidValidity)
}

async function store(
  messages: Parameters<typeof runPipeline>[0][],
  cutoff: number,
  /** False for a folder's first fetch: old mail would read as a slow push. */
  measure = true
): Promise<number> {
  let n = 0
  let slowest: number | null = null
  const dropped = new Set<number>()
  for (const raw of messages) {
    const date = raw.envelope?.date
    if (date && date.getTime() < cutoff) {
      if (raw.folderId != null) dropped.add(raw.folderId)
      continue
    }
    const r = await runPipeline(raw, processors)
    if (r.id === null) continue
    n++
    const ms = measure ? noteArrival(raw.internalDate) : null
    if (ms !== null) slowest = Math.max(slowest ?? 0, ms)
  }
  if (slowest !== null) {
    const s = latencySummary()
    console.log(
      `[sync] new mail stored ${(slowest / 1000).toFixed(1)}s after the server got it ` +
        `(p50 ${(s.p50 / 1000).toFixed(1)}s, p90 ${(s.p90 / 1000).toFixed(1)}s over ${s.count})`
    )
  }
  // The caller still moves last_uid past dropped mail; leave it to backfill.
  for (const id of dropped) reopenHistory(id)
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
  const cutoff = forwardCutoff(opts.sinceDays ?? DEFAULTS.sinceDays)
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
  const n = await store(messages, cutoff, folder.last_uid > 0)
  setLastUid(folder.id, maxUid(messages))
  return n
}
