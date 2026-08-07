import { BrowserWindow } from 'electron'
import type { AccountConfig } from '../src/core/accounts/config.js'
import { startIdleWatcher, stopIdleWatcher } from '../src/core/sync/idle.js'
import { closePool, getPool } from '../src/core/sync/pool.js'
import { refreshFolderNow } from '../src/core/sync/syncEngine.js'
import { findFolderByPath } from '../src/core/store/repo.js'

/** Exmail uses "Sent Messages"; other hosts vary. */
const SENT_PATHS = ['Sent Messages', 'Sent', 'INBOX.Sent']

/** Warmed pool + parked IDLE connection for one account. */
export function startAccountWorkers(config: AccountConfig): void {
  // Pay the ~2.7s handshake now, while nothing is waiting on it.
  void getPool(config).warm()
  startIdleWatcher(config, () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('mail:new')
  })
}

export function stopAccountWorkers(email: string): void {
  stopIdleWatcher(email)
  void closePool(email)
}

/**
 * Pulls the just-sent copy into the local Sent folder.
 *
 * The server files it asynchronously and the IDLE watcher only holds INBOX
 * open, so without this the message waits for the 60s background poll. Runs on
 * the shared pool, which is already authenticated — the ~2.8s login is what
 * made a fresh connection too slow to do this inline.
 */
export async function refreshSentFolder(accountId: number, config: AccountConfig): Promise<void> {
  const folder = SENT_PATHS.map((p) => findFolderByPath(accountId, p)).find(Boolean)
  if (!folder) return
  try {
    const n = await getPool(config).withConnection((client) =>
      refreshFolderNow(client, accountId, {
        id: folder.id,
        path: folder.path,
        last_uid: folder.last_uid
      })
    )
    if (n > 0) {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('mail:sent-stored', { accountId, folderId: folder.id })
      }
    }
  } catch (err) {
    // The background sync still picks it up; this is only the fast path.
    console.error('[send] Sent refresh failed:', err)
  }
}
