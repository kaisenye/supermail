import { ipcMain } from 'electron'
import { contactProfile, threadCounterpart } from '../src/core/store/contacts.js'
import { queuedSourceUids } from '../src/core/store/moveJobs.js'
import { listFolders, searchMessages } from '../src/core/store/repo.js'
import { mergeByDate } from '../src/core/store/searchAll.js'
import { deleteSnippet, listSnippets, saveSnippet } from '../src/core/store/snippets.js'
import { searchTasks } from '../src/core/store/tasks.js'
import {
  countUnified,
  inboxScopes,
  listUnified,
  unifiedSplitCounts,
  unifiedUnread
} from '../src/core/store/unified.js'
import { shouldSyncFolder } from '../src/core/sync/folderFilter.js'
import { getPool } from '../src/core/sync/pool.js'
import { gmailRawQuery } from '../src/core/sync/serverSearch.js'
import { serverSearchFolder } from '../src/core/sync/syncEngine.js'
import { heldSourceUids } from './ipc.js'
import { getBootState, listAccounts } from './state.js'

/** Every connected account's Inbox, in sidebar order. */
const scopes = () => inboxScopes(listAccounts().map((a) => a.accountId))

/**
 * Phase 3 handlers (unified inbox, snippets, search page, contact pane). Kept
 * out of ipc.ts, which owns sync, compose and the move hold.
 */
export function registerPowerIpc(): void {
  ipcMain.handle('unified:list', (_e, limit = 50, offset = 0, query = '') =>
    listUnified(scopes(), { limit, offset, query })
  )
  ipcMain.handle('unified:count', (_e, query = '') => countUnified(scopes(), { query }))
  ipcMain.handle('unified:splitCounts', (_e, extraQuery = '') => unifiedSplitCounts(scopes(), extraQuery))
  ipcMain.handle('unified:unread', () => unifiedUnread(scopes()))

  ipcMain.handle('snippets:list', () => listSnippets())
  ipcMain.handle('snippets:save', (_e, input: { id?: number; name: string; shortcut?: string | null; body: string }) => {
    try {
      return { ok: true as const, snippet: saveSnippet(input) }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })
  ipcMain.handle('snippets:delete', (_e, id: number) => {
    deleteSnippet(id)
    return { ok: true as const }
  })

  // Gmail only: ask the server, store hits older than the local window, and
  // let the renderer search again. At most 50 new messages per folder per call.
  // Moves still in flight (undo window or move_jobs) are skipped, as backfill
  // does, so a just-archived mail does not come back in its source folder.
  // A folder whose UIDVALIDITY changed since the last sync is skipped; the
  // next full sync resets it.
  // Known gap: only the synced system folders are searched (Inbox, Sent,
  // Drafts, Trash, Spam). Archived Gmail mail lives only in All Mail, which is
  // not synced, so server search cannot reach it.
  ipcMain.handle('search:server', async (_e, query: string) => {
    const raw = gmailRawQuery(query)
    if (!raw) return { ok: true as const, stored: 0 }
    let stored = 0
    for (const a of listAccounts()) {
      if (a.config.provider !== 'gmail') continue
      const folders = listFolders(a.accountId).filter((f) => shouldSyncFolder('gmail', f))
      try {
        stored += await getPool(a.config).withConnection(async (client) => {
          let n = 0
          for (const f of folders) {
            const skip = [...heldSourceUids(a.accountId, f.path), ...queuedSourceUids(a.accountId, f.path)]
            n += await serverSearchFolder(client, a.accountId, f, raw, skip, 50)
          }
          return n
        })
      } catch (e) {
        return { ok: false as const, error: (e as Error).message }
      }
    }
    return { ok: true as const, stored }
  })

  // Every account, each query scoped to its own account_id.
  ipcMain.handle('search:all', (_e, query: string, limit = 100) =>
    mergeByDate(listAccounts().map((a) => searchMessages(a.accountId, query, limit)), limit)
  )

  ipcMain.handle('tasks:search', (_e, query: string, limit = 50) => {
    const s = getBootState()
    return s.ok ? searchTasks(s.accountId, query, limit) : []
  })

  ipcMain.handle('contact:forThread', (_e, threadId: string, accountId?: number) => {
    const s = getBootState()
    const acct = accountId ?? (s.ok ? s.accountId : null)
    if (acct == null) return null
    const address = threadCounterpart(acct, threadId)
    return address ? contactProfile(acct, address) : null
  })
}
