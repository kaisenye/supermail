import { BrowserWindow } from 'electron'
import type { AccountConfig } from '../src/core/accounts/config.js'
import { startIdleWatcher, stopIdleWatcher, watchMailbox } from '../src/core/sync/idle.js'
import { closePool, getPool } from '../src/core/sync/pool.js'
import { refreshFolderNow } from '../src/core/sync/syncEngine.js'
import { findFolderByPath, folderByRole } from '../src/core/store/repo.js'
import { hasSentCopy, serialPerKey, waitForSentCopy } from '../src/core/send/sentRefresh.js'

/** Warmed pool + parked IDLE connection for one account. */
export function startAccountWorkers(config: AccountConfig): void {
  // Pay the ~2.7s handshake now, while nothing is waiting on it.
  void getPool(config).warm()
  // Carries the account: the renderer syncs that one, not whichever is on screen.
  startIdleWatcher(config, () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('mail:new', config.email)
  })
}

/**
 * Push for the account's Sent folder, on its own parked connection: mail sent
 * from webmail or a phone shows up in seconds instead of at the next poll.
 * Idempotent; called at boot and after every sync, since a new account's Sent
 * folder is only known once its first sync has assigned roles.
 */
export function watchSentFolder(accountId: number, config: AccountConfig): void {
  const path = folderByRole(accountId, 'sent')?.path
  if (!path) return
  watchMailbox(config, 'sent', path, () => void refreshSentFolder(accountId, config, null, 1))
}

export function stopAccountWorkers(email: string): void {
  stopIdleWatcher(email)
  void closePool(email)
}

const sentRefreshes = serialPerKey()

/**
 * Pulls the just-sent copy into the local Sent folder.
 *
 * The server files it asynchronously, and the Sent watcher may not be
 * connected (or the server may not push for its own APPEND), so without this
 * the message can wait for the 60s background poll. Waits
 * for `messageId` itself: with two quick sends, a poll can bring the other
 * send's copy. One refresh per account at a time, on the shared pool.
 */
export function refreshSentFolder(
  accountId: number,
  config: AccountConfig,
  messageId: string | null,
  /** 1 for a push: the server already said something arrived. */
  attempts?: number
): Promise<void> {
  return sentRefreshes(accountId, async () => {
    const path = folderByRole(accountId, 'sent')?.path
    if (!path) return
    let storedAny = false
    try {
      const found = await waitForSentCopy({
        attempts,
        poll: async () => {
          // Re-read: last_uid moves when a poll or the background sync stores
          // rows, and a stale cursor would re-fetch what is already local.
          const folder = findFolderByPath(accountId, path)
          if (!folder) return 0
          const n = await getPool(config).withConnection((client) =>
            refreshFolderNow(client, accountId, {
              id: folder.id,
              path: folder.path,
              last_uid: folder.last_uid
            })
          )
          if (n > 0) {
            storedAny = true
            for (const w of BrowserWindow.getAllWindows())
              w.webContents.send('mail:sent-stored', { accountId, folderId: folder.id })
          }
          return n
        },
        stored: () => {
          const folder = findFolderByPath(accountId, path)
          if (!folder) return true
          // Without a Message-ID (never expected), any new row ends the wait, as before.
          return messageId ? hasSentCopy(accountId, folder.id, messageId) : storedAny
        }
      })
      if (!found && messageId) console.warn(`[send] Sent copy ${messageId ?? ''} not seen yet; background sync will pick it up`)
    } catch (err) {
      // The background sync still picks it up; this is only the fast path.
      console.error('[send] Sent refresh failed:', err)
    }
  })
}
