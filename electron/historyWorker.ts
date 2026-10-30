import { getSettings, listFolders, newestSyncedUid, setHistoryComplete } from '../src/core/store/repo.js'
import { backfillFolder } from '../src/core/sync/syncEngine.js'
import { shouldSyncFolder } from '../src/core/sync/folderFilter.js'
import { createHistoryTick, forwardSynced } from './historyTick.js'
import { runBackfillExclusive } from './backfillLock.js'
import { heldSourceUids } from './ipc.js'
import { listAccounts } from './state.js'

const PAGE = 500
let timer: ReturnType<typeof setInterval> | null = null

/**
 * Full offline history: one page of older headers per account per tick, until
 * each synced folder reaches uid 1. Bodies stay on demand. Off when
 * settings.full_history is '0'. Runs only while the app does, like every
 * other worker.
 */
export function startHistoryWorker(intervalMs = 60_000): void {
  if (timer) return
  let running = false
  const pass = createHistoryTick({
    accounts: listAccounts,
    // A folder the forward sync has not reached yet belongs to it, not to backfill.
    folders: (a) =>
      listFolders(a.accountId).filter(
        (f) => shouldSyncFolder(a.config.provider, f) && forwardSynced(f, newestSyncedUid(f.id))
      ),
    backfill: (a, f) =>
      runBackfillExclusive(a.accountId, () =>
        backfillFolder(a.accountId, a.config, f, PAGE, () => heldSourceUids(a.accountId, f.path))
      ),
    complete: (f) => {
      if (f.uidvalidity != null) setHistoryComplete(f.id, f.uidvalidity)
    }
  })
  const tick = async (): Promise<void> => {
    if (running || getSettings().full_history === '0') return
    running = true
    try {
      await pass()
    } finally {
      running = false
    }
  }
  timer = setInterval(() => void tick(), intervalMs)
}
