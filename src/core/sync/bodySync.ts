import type { AccountConfig } from '../accounts/config.js'
import { processors } from '../pipeline/index.js'
import { runPipeline } from '../pipeline/pipeline.js'
import { listFolders, listUnfetchedUids } from '../store/repo.js'
import { createClient, fetchSourcesBatch } from './imap.js'

export interface BodySyncProgress {
  fetched: number
  total: number
  folder: string
  done: boolean
}

// Smaller server-side batches so imapflow starts streaming sooner and the UI
// sees progress quickly, instead of waiting on one huge FETCH.
const BATCH = 20

/**
 * Fetches every missing body over ONE reused connection. The original slowness
 * was one TLS handshake per opened message; here the handshake is paid once and
 * amortised across the whole mailbox, so threads open instantly afterwards.
 *
 * Runs after the envelope pass, in the background — the list is already painted
 * from envelopes, so this never blocks reading.
 */
export async function syncBodies(
  accountId: number,
  config: AccountConfig,
  opts: {
    onProgress?: (p: BodySyncProgress) => void
    signal?: () => boolean
  } = {}
): Promise<{ fetched: number }> {
  const progress = opts.onProgress ?? (() => {})
  const cancelled = opts.signal ?? (() => false)

  // INBOX first — that's what the user is looking at.
  const folders = listFolders(accountId).sort((a, b) =>
    a.path === 'INBOX' ? -1 : b.path === 'INBOX' ? 1 : 0
  )

  const plan = folders
    .map((f) => ({ folder: f, uids: listUnfetchedUids(f.id) }))
    .filter((p) => p.uids.length > 0)
  const total = plan.reduce((n, p) => n + p.uids.length, 0)
  if (total === 0) return { fetched: 0 }

  let fetched = 0
  const client = createClient(config)
  await client.connect()

  try {
    for (const { folder, uids } of plan) {
      if (cancelled()) break
      for (let i = 0; i < uids.length; i += BATCH) {
        if (cancelled()) break
        const slice = uids.slice(i, i + BATCH)
        await fetchSourcesBatch(client, folder.path, slice, async (uid, source) => {
          // Parse+store is ~120ms and the next message's ~360ms network wait
          // dominates, so serial pipelining here is fine and keeps memory flat.
          try {
            await runPipeline({ accountId, folderId: folder.id, uid, source }, processors)
          } catch {
            // One bad message must not abort the batch.
          }
          fetched++
          progress({ fetched, total, folder: folder.path, done: false })
        })
      }
    }
  } finally {
    await client.logout().catch(() => {})
  }

  progress({ fetched, total, folder: '', done: true })
  return { fetched }
}
