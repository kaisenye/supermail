import { BrowserWindow, ipcMain, shell } from 'electron'
import { syncAccount } from '../src/core/sync/syncEngine.js'
import { ensureBody } from '../src/core/sync/fetchBody.js'
import { syncBodies } from '../src/core/sync/bodySync.js'
import { FlagWriter } from '../src/core/sync/flagWriter.js'
import { MoveWriter } from '../src/core/sync/moveWriter.js'
import {
  addFlag,
  createDraft,
  deleteMessageLocal,
  findFolderByPath,
  getMessage,
  getMessageLocation,
  getThread,
  listAttachments,
  listFolders,
  listInbox,
  moveMessage,
  removeFlag,
  searchMessages,
  toggleFlag,
  updateDraft
} from '../src/core/store/repo.js'
import { sanitizeEmailHtml, textToHtml } from '../src/core/render/sanitize.js'
import {
  cancelOutbox,
  enqueueOutbox,
  listPendingOutbox
} from '../src/core/send/outbox.js'
import { getBootState, getBootStatus } from './state.js'

export const UNDO_SEND_MS = 10_000

let syncing = false
let bodySyncing = false
let flagWriter: FlagWriter | null = null
let moveWriter: MoveWriter | null = null

const ARCHIVE_PATHS = ['Archive', 'Archives', '已归档']
const TRASH_PATHS = ['Deleted Messages', 'Trash', 'Deleted']

function resolveDestPath(
  accountId: number,
  kind: 'archive' | 'trash'
): string | null {
  const candidates = kind === 'archive' ? ARCHIVE_PATHS : TRASH_PATHS
  for (const p of candidates) {
    if (findFolderByPath(accountId, p)) return p
  }
  return candidates[0] ?? null
}

interface DraftPayload {
  draftId: number | null
  to: string
  cc?: string
  bcc?: string
  subject?: string
  body?: string
  inReplyTo?: string | null
  references?: string | null
}

interface QueueSendPayload extends DraftPayload {
  draftId: number
  sendAt: number
}

export function registerIpc(): void {
  ipcMain.handle('boot:status', () => getBootStatus())

  // Optimistic star: mutate SQLite now, push the IMAP write to the background.
  ipcMain.handle('message:toggleFlag', (_e, id: number, flag: string) => {
    const s = getBootState()
    if (!s.ok) return { ok: false as const, error: s.error }
    const next = toggleFlag(id, flag)
    const nowHas = next.some((f) => f.toLowerCase() === flag.toLowerCase())
    if (!flagWriter) flagWriter = new FlagWriter(s.config)
    flagWriter.enqueue({ messageId: id, flag, add: nowHas })
    return { ok: true as const, flags: next }
  })

  // Bulk set/clear a flag (read, unread, star). Returns per-id new flags.
  ipcMain.handle(
    'messages:setFlag',
    (_e, ids: number[], flag: string, add: boolean) => {
      const s = getBootState()
      if (!s.ok) return { ok: false as const, error: s.error }
      if (!flagWriter) flagWriter = new FlagWriter(s.config)
      const updated: { id: number; flags: string[] }[] = []
      for (const id of ids) {
        const next = add ? addFlag(id, flag) : removeFlag(id, flag)
        if (!next) continue
        flagWriter.enqueue({ messageId: id, flag, add })
        updated.push({ id, flags: next })
      }
      return { ok: true as const, updated }
    }
  )

  // Optimistic local remove + background IMAP MOVE to archive/trash.
  ipcMain.handle(
    'messages:move',
    (_e, ids: number[], kind: 'archive' | 'trash') => {
      const s = getBootState()
      if (!s.ok) return { ok: false as const, error: s.error }
      const toPath = resolveDestPath(s.accountId, kind)
      if (!toPath) return { ok: false as const, error: `no ${kind} folder` }
      const dest = findFolderByPath(s.accountId, toPath)
      if (!moveWriter) moveWriter = new MoveWriter(s.config)
      const moved: number[] = []
      for (const id of ids) {
        const loc = getMessageLocation(id)
        if (!loc) continue
        if (loc.path === toPath) continue
        moveWriter.enqueue({ fromPath: loc.path, uid: loc.uid, toPath })
        if (dest) moveMessage(id, dest.id)
        else deleteMessageLocal(id)
        moved.push(id)
      }
      return { ok: true as const, moved, toPath }
    }
  )

  ipcMain.handle('folders:list', () => {
    const s = getBootState()
    return s.ok ? listFolders(s.accountId) : []
  })

  ipcMain.handle('messages:list', (_e, folderId: number, limit = 100, offset = 0) =>
    listInbox(folderId, limit, offset)
  )

  ipcMain.handle('messages:search', (_e, query: string, limit = 100) =>
    searchMessages(query, limit)
  )

  ipcMain.handle('thread:get', (_e, threadId: string) => getThread(threadId))

  // Mark every message in a thread \Seen. Optimistic: SQLite first, IMAP in the
  // background. Returns the ids whose read-state actually changed so the list
  // can clear their unread dots.
  ipcMain.handle('thread:markRead', (_e, threadId: string) => {
    const s = getBootState()
    if (!s.ok) return { ok: false as const, error: s.error }
    if (!flagWriter) flagWriter = new FlagWriter(s.config)
    const changed: number[] = []
    for (const m of getThread(threadId)) {
      const next = addFlag(m.id, '\\Seen')
      if (next) {
        changed.push(m.id)
        flagWriter.enqueue({ messageId: m.id, flag: '\\Seen', add: true })
      }
    }
    return { ok: true as const, changed }
  })

  ipcMain.handle(
    'message:body',
    async (_e, messageId: number, allowRemoteImages = false) => {
      const s = getBootState()
      if (!s.ok) return { ok: false as const, error: s.error }
      try {
        const msg = await ensureBody(s.accountId, s.config, messageId)
        if (!msg) return { ok: false as const, error: 'message not found' }

        // Sanitising in main means the renderer never sees raw email HTML.
        const rendered = msg.body_html
          ? sanitizeEmailHtml(msg.body_html, { allowRemoteImages })
          : { html: textToHtml(msg.body_text ?? ''), blockedImages: 0 }

        return {
          ok: true as const,
          id: msg.id,
          html: rendered.html,
          blockedImages: rendered.blockedImages,
          isHtml: !!msg.body_html,
          attachments: listAttachments(msg.id)
        }
      } catch (e) {
        return { ok: false as const, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle('message:get', (_e, id: number) => getMessage(id))

  ipcMain.handle('compose:saveDraft', (_e, payload: DraftPayload) => {
    const s = getBootState()
    if (!s.ok) return { ok: false as const, error: s.error }
    try {
      const fields = {
        to_addrs: payload.to.trim(),
        cc_addrs: payload.cc?.trim() || null,
        subject: payload.subject ?? '',
        body_text: payload.body ?? '',
        body_html: null as string | null,
        in_reply_to: payload.inReplyTo ?? null
      }
      let draftId = payload.draftId
      if (draftId) {
        updateDraft(draftId, fields)
      } else {
        draftId = createDraft({
          account_id: s.accountId,
          from_addr: s.config.email,
          ...fields
        })
      }
      return { ok: true as const, draftId }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  ipcMain.handle('compose:queueSend', (_e, payload: QueueSendPayload) => {
    const s = getBootState()
    if (!s.ok) return { ok: false as const, error: s.error }
    if (!payload.to?.trim()) return { ok: false as const, error: 'missing recipients' }
    try {
      updateDraft(payload.draftId, {
        to_addrs: payload.to.trim(),
        cc_addrs: payload.cc?.trim() || null,
        subject: payload.subject ?? '',
        body_text: payload.body ?? '',
        body_html: null,
        in_reply_to: payload.inReplyTo ?? null
      })
      const row = enqueueOutbox({
        account_id: s.accountId,
        draft_message_id: payload.draftId,
        to_addrs: payload.to.trim(),
        cc_addrs: payload.cc?.trim() || null,
        bcc_addrs: payload.bcc?.trim() || null,
        subject: payload.subject ?? '',
        body_text: payload.body ?? '',
        body_html: null,
        in_reply_to: payload.inReplyTo ?? null,
        references_header: payload.references ?? null,
        send_at: payload.sendAt
      })
      return { ok: true as const, outboxId: row.id, sendAt: row.send_at }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  ipcMain.handle('compose:cancelSend', (_e, outboxId: number) => {
    const s = getBootState()
    if (!s.ok) return { ok: false as const, error: s.error }
    return { ok: true as const, cancelled: cancelOutbox(outboxId) }
  })

  ipcMain.handle('compose:listScheduled', () => {
    const s = getBootState()
    if (!s.ok) return []
    return listPendingOutbox(s.accountId)
      .filter((r) => r.send_at > Date.now() + UNDO_SEND_MS)
      .map((r) => ({
        id: r.id,
        to_addrs: r.to_addrs,
        subject: r.subject,
        send_at: r.send_at,
        status: r.status
      }))
  })

  // Bulk body fetch over one reused connection. Fire-and-forget: the caller
  // starts it, progress arrives via 'bodySync:progress', and threads become
  // instant to open as bodies land.
  ipcMain.handle('bodySync:run', async () => {
    const s = getBootState()
    if (!s.ok) return { ok: false as const, error: s.error }
    if (bodySyncing) return { ok: false as const, error: 'already running' }

    bodySyncing = true
    try {
      const result = await syncBodies(s.accountId, s.config, {
        onProgress: (p) => {
          for (const w of BrowserWindow.getAllWindows())
            w.webContents.send('bodySync:progress', p)
        }
      })
      return { ok: true as const, ...result }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    } finally {
      bodySyncing = false
    }
  })

  // Links from mail open in the real browser, never inside the app frame.
  ipcMain.handle('shell:open', async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) return false
    await shell.openExternal(url)
    return true
  })

  ipcMain.handle('sync:run', async () => {
    const s = getBootState()
    if (!s.ok) return { ok: false, error: s.error }
    // Overlap is normal (timer + focus + boot) — skip quietly, not an error.
    if (syncing) {
      return { ok: true, folders: 0, messages: 0, errors: [], skipped: true }
    }

    syncing = true
    try {
      const result = await syncAccount(s.accountId, s.config, {
        onProgress: (p) => {
          for (const w of BrowserWindow.getAllWindows()) w.webContents.send('sync:progress', p)
        }
      })
      return { ok: true, ...result, skipped: false }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    } finally {
      syncing = false
    }
  })
}
