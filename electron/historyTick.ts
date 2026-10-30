import { nextHistoryFolder } from '../src/core/sync/historyPlan.js'
import type { Folder } from '../src/core/store/types.js'

type HistoryFolder = Pick<Folder, 'id' | 'path' | 'role' | 'uidvalidity'> & { history_complete?: number }

/**
 * Whether the forward sync has run on a folder, so backfill may take it. A
 * folder whose mail is all older than the sinceDays window has no local rows
 * but a last_uid, and still needs its history.
 */
export function forwardSynced(folder: Pick<Folder, 'last_uid'>, newestLocalUid: number | null): boolean {
  return newestLocalUid !== null || folder.last_uid > 0
}

export interface HistoryTickDeps<A extends { accountId: number }, F extends HistoryFolder> {
  accounts: () => A[]
  /** The account's folders eligible for backfill. */
  folders: (a: A) => F[]
  /** One page; null when another backfill holds the account. */
  backfill: (a: A, f: F) => Promise<{ more: boolean } | null>
  complete: (f: F) => void
  now?: () => number
  /** How long a folder that threw sits out before it is tried again. */
  retryMs?: number
}

/**
 * One history pass: a page per account. Each account is tried on its own, so
 * one that is offline or needs a new sign-in does not stop the rest. A folder
 * that throws (deleted or renamed on the server, say) sits out for `retryMs`,
 * so the account moves on to its next folder instead of hitting it every tick.
 */
export function createHistoryTick<A extends { accountId: number }, F extends HistoryFolder>(
  deps: HistoryTickDeps<A, F>
): () => Promise<void> {
  const failed = new Map<number, number>()
  const retryMs = deps.retryMs ?? 15 * 60_000
  const now = deps.now ?? Date.now
  return async () => {
    for (const a of deps.accounts()) {
      const t = now()
      const folders = deps.folders(a).filter((f) => (failed.get(f.id) ?? 0) <= t)
      const next = nextHistoryFolder(folders)
      if (!next) continue
      try {
        const r = await deps.backfill(a, next)
        failed.delete(next.id)
        if (r && !r.more && next.uidvalidity != null) deps.complete(next)
      } catch (e) {
        failed.set(next.id, t + retryMs)
        console.error(`[history] backfill failed (account ${a.accountId}, ${next.path}):`, e)
      }
    }
  }
}
