import type { ImapFlow } from 'imapflow'
import type { AccountConfig } from '../accounts/config.js'
import { processors } from '../pipeline/index.js'
import { runPipeline } from '../pipeline/pipeline.js'
import { getDb } from '../store/db.js'
import {
  listFolders,
  resetFolder,
  setLastUid,
  upsertFolder
} from '../store/repo.js'
import {
  createClient,
  fetchEnvelopes,
  listMailboxes,
  mailboxStatus,
  type MailboxStatus
} from './imap.js'

export interface SyncOptions {
  /** Cap per folder on the initial pass. */
  maxPerFolder?: number
  /** Skip messages older than this. */
  sinceDays?: number
  onProgress?: (p: SyncProgress) => void
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
  errors: { folder: string; message: string }[]
}

const DEFAULTS = { maxPerFolder: 2000, sinceDays: 90 }

export async function syncAccount(
  accountId: number,
  config: AccountConfig,
  opts: SyncOptions = {}
): Promise<SyncResult> {
  const maxPerFolder = opts.maxPerFolder ?? DEFAULTS.maxPerFolder
  const sinceDays = opts.sinceDays ?? DEFAULTS.sinceDays
  const cutoff = Date.now() - sinceDays * 86_400_000
  const progress = opts.onProgress ?? (() => {})

  const result: SyncResult = { folders: 0, messages: 0, errors: [] }
  const client: ImapFlow = createClient(config)

  progress({ phase: 'connect' })
  await client.connect()

  try {
    progress({ phase: 'folders' })
    const boxes = await listMailboxes(client)
    for (const b of boxes) {
      // \NoSelect entries are containers, not mailboxes.
      if (!b.selectable) continue
      upsertFolder({ account_id: accountId, name: b.name, path: b.path, uidvalidity: null })
      result.folders++
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
        const unchanged =
          folder.uidvalidity === pre.uidValidity && pre.uidNext <= folder.last_uid + 1
        if (unchanged) {
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

function maxUid(messages: { uid: number | null }[]): number {
  return messages.reduce((m, x) => Math.max(m, x.uid ?? 0), 0)
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
