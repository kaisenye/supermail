import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename, extname } from 'path'
import { copyFileSync, readFileSync, statSync } from 'fs'
import { attachmentPath, signatureLogoPath } from '../src/core/store/attachments.js'
import {
  backfillFolder,
  repairThreading,
  rethreadDone,
  syncAccount
} from '../src/core/sync/syncEngine.js'
import { ensureBody } from '../src/core/sync/fetchBody.js'
import { syncBodies } from '../src/core/sync/bodySync.js'
import { FlagWriter } from '../src/core/sync/flagWriter.js'
import { MoveWriter } from '../src/core/sync/moveWriter.js'
import type { AccountConfig } from '../src/core/accounts/config.js'
import { listPresets, presetFor } from '../src/core/accounts/presets.js'
import { verifyAccount } from '../src/core/accounts/verify.js'
import {
  forgetAccount,
  rememberDisplayName,
  saveAccount,
  toConfig,
  type NewAccountInput
} from '../src/core/accounts/manage.js'
import { startAccountWorkers, stopAccountWorkers } from './workers.js'
import {
  countOpenTasks,
  createTask,
  deleteTask,
  listTasks,
  setTaskDone,
  updateTask,
  type Priority,
  type TaskPatch,
  type TaskQuery
} from '../src/core/store/tasks.js'
import {
  addFlag,
  countDrafts,
  deleteAccount,
  listAccounts as storedAccounts,
  countInbox,
  createDraft,
  searchContacts,
  deleteDraft,
  findFolderByPath,
  getAttachment,
  getMessage,
  getSettings,
  setSetting,
  getMessageLocation,
  getThread,
  listAttachments,
  listDrafts,
  listInlineParts,
  listFolders,
  listInbox,
  moveMessage,
  removeFlag,
  restoreMessage,
  searchMessages,
  toggleFlag,
  unreadCounts,
  updateDraft
} from '../src/core/store/repo.js'
import { sanitizeEmailHtml, textToHtml } from '../src/core/render/sanitize.js'
import { htmlToPlainText } from '../src/core/send/mime.js'
import {
  cancelOutbox,
  enqueueOutbox,
  listPendingOutbox
} from '../src/core/send/outbox.js'
import {
  addAccount as addAccountToState,
  getAccount,
  getBootState,
  getBootStatus,
  removeAccount as removeAccountFromState,
  setActiveAccount
} from './state.js'

/** A signature rides on every message, so a big logo is a per-send tax. */
const MAX_LOGO_BYTES = 512 * 1024

const LOGO_MIMES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

function logoMime(ext: string): string {
  return LOGO_MIMES[ext.toLowerCase()] ?? 'application/octet-stream'
}

export const UNDO_SEND_MS = 3_000
export const UNDO_MOVE_MS = 3_000

// All keyed by accountId — a shared flag would let one account's in-flight
// sync suppress another's, and a shared writer would target the wrong server.
const syncing = new Set<number>()
const bodySyncing = new Set<number>()
const backfilling = new Set<number>()
const flagWriters = new Map<number, FlagWriter>()
const moveWriters = new Map<number, MoveWriter>()

function flagWriterFor(accountId: number, config: AccountConfig): FlagWriter {
  let w = flagWriters.get(accountId)
  if (!w) {
    w = new FlagWriter(config)
    flagWriters.set(accountId, w)
  }
  return w
}

function moveWriterFor(accountId: number, config: AccountConfig): MoveWriter {
  let w = moveWriters.get(accountId)
  if (!w) {
    w = new MoveWriter(config)
    moveWriters.set(accountId, w)
  }
  return w
}

interface PendingMove {
  id: number
  accountId: number
  fromFolderId: number
  fromPath: string
  uid: number
  toPath: string
}

let moveBatchSeq = 0
const pendingMoves = new Map<
  number,
  { jobs: PendingMove[]; timer: ReturnType<typeof setTimeout> }
>()

/** Undo window elapsed — the IMAP MOVE is now safe to issue. */
function commitMove(batchId: number): void {
  const batch = pendingMoves.get(batchId)
  if (!batch) return
  clearTimeout(batch.timer)
  pendingMoves.delete(batchId)
  // Resolve the account from the job, not from whichever is active now: the
  // user may have switched during the undo window.
  for (const j of batch.jobs) {
    const acct = getAccount(j.accountId)
    if (!acct) continue
    moveWriterFor(acct.accountId, acct.config).enqueue({
      fromPath: j.fromPath,
      uid: j.uid,
      toPath: j.toPath
    })
  }
}

/** Quitting mid-window must not strand a move that SQLite already applied. */
/**
 * Real image type for an inline part. Senders often label these
 * application/octet-stream, which a browser will refuse to render, so fall
 * back to sniffing magic bytes. Returns null when it is not an image at all.
 */
function imageMime(declared: string | null, buf: Buffer): string | null {
  const d = (declared ?? '').toLowerCase().split(';')[0].trim()
  if (/^image\/[a-z0-9.+-]+$/.test(d)) return d
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    return 'image/png'
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (buf.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif'
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp'
  return null
}

/**
 * Rewrites <img src="cid:..."> to a data: URL from the stored part. The
 * browser cannot fetch cid:, so without this an embedded image — a logo in a
 * signature, most commonly — renders as a broken icon.
 */
function inlineCidImages(messageId: number, html: string): string {
  if (!html.includes('cid:')) return html
  const parts = listInlineParts(messageId)
  if (!parts.length) return html

  const byCid = new Map<string, { mime: string | null; storage_path: string | null }>()
  for (const p of parts) {
    // Senders write <logo@host> in the header but cid:logo@host in the body.
    byCid.set(String(p.part_id).replace(/^<|>$/g, '').toLowerCase(), p)
  }

  return html.replace(/(<img\b[^>]*\bsrc=")cid:([^"]+)(")/gi, (whole, pre, cid, post) => {
    const part = byCid.get(decodeURIComponent(cid).trim().toLowerCase())
    if (!part?.storage_path) return whole
    try {
      const buf = readFileSync(part.storage_path)
      const mime = imageMime(part.mime, buf)
      if (!mime) return whole
      return `${pre}data:${mime};base64,${buf.toString('base64')}${post}`
    } catch {
      return whole
    }
  })
}

export function flushPendingMoves(): void {
  for (const batchId of [...pendingMoves.keys()]) commitMove(batchId)
}

// Exmail has no Archive mailbox, so trash is the only move destination.
const TRASH_PATHS = ['Deleted Messages', 'Trash', 'Deleted']

function resolveTrashPath(accountId: number): string | null {
  for (const p of TRASH_PATHS) {
    if (findFolderByPath(accountId, p)) return p
  }
  // No fallback: moving into a mailbox that doesn't exist loses the message.
  return null
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
  attachments?: ComposeAttachment[]
}

interface ComposeAttachment {
  path: string
  filename: string
  contentType: string
  size: number
}

interface QueueSendPayload extends DraftPayload {
  draftId: number
  sendAt: number
  attachments?: ComposeAttachment[]
}

export function registerIpc(): void {
  ipcMain.handle('boot:status', () => getBootStatus())

  ipcMain.handle('account:presets', () => listPresets())

  // Prefill from the address alone, so most users never open Advanced.
  ipcMain.handle('account:preset', (_e, email: string) => presetFor(email))

  // Dials the real servers before anything is saved: a typo surfaces here
  // instead of as mail that silently fails to send days later.
  ipcMain.handle('account:test', async (_e, input: NewAccountInput) => {
    try {
      return await verifyAccount(toConfig(input))
    } catch (e) {
      return { ok: false as const, message: (e as Error).message }
    }
  })

  ipcMain.handle('account:add', async (_e, input: NewAccountInput) => {
    const config = toConfig(input)
    // Verify before persisting, so a failed add leaves nothing behind.
    const check = await verifyAccount(config)
    if (!check.ok) return { ok: false as const, error: check.message ?? 'connection failed' }
    try {
      const { account } = saveAccount(input)
      rememberDisplayName(account.id, config.name)
      addAccountToState({ accountId: account.id, email: account.email, config })
      setActiveAccount(account.id)
      startAccountWorkers(config)
      return { ok: true as const, accountId: account.id, email: account.email }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  ipcMain.handle('account:setActive', (_e, accountId: number) => {
    return { ok: setActiveAccount(accountId) }
  })

  ipcMain.handle('account:remove', (_e, accountId: number) => {
    const live = getAccount(accountId)
    const row = storedAccounts().find((a) => a.id === accountId)
    if (!row) return { ok: false as const, error: 'no such account' }
    if (live) stopAccountWorkers(live.email)
    forgetAccount(row)
    // ON DELETE CASCADE clears folders and messages with the row.
    deleteAccount(accountId)
    removeAccountFromState(accountId)
    return { ok: true as const }
  })

  // Optimistic star: mutate SQLite now, push the IMAP write to the background.
  ipcMain.handle('message:toggleFlag', (_e, id: number, flag: string) => {
    const s = getBootState()
    if (!s.ok) return { ok: false as const, error: s.error }
    const next = toggleFlag(id, flag)
    const nowHas = next.some((f) => f.toLowerCase() === flag.toLowerCase())
    flagWriterFor(s.accountId, s.config).enqueue({ messageId: id, flag, add: nowHas })
    return { ok: true as const, flags: next }
  })

  // Bulk set/clear a flag (read, unread, star). Returns per-id new flags.
  ipcMain.handle(
    'messages:setFlag',
    (_e, ids: number[], flag: string, add: boolean) => {
      const s = getBootState()
      if (!s.ok) return { ok: false as const, error: s.error }
      const writer = flagWriterFor(s.accountId, s.config)
      const updated: { id: number; flags: string[] }[] = []
      for (const id of ids) {
        const next = add ? addFlag(id, flag) : removeFlag(id, flag)
        if (!next) continue
        writer.enqueue({ messageId: id, flag, add })
        updated.push({ id, flags: next })
      }
      return { ok: true as const, updated }
    }
  )

  // Optimistic local move now; the IMAP MOVE is held for UNDO_MOVE_MS so undo
  // is a local rollback rather than a compensating reverse MOVE on the server.
  ipcMain.handle(
    'messages:move',
    (_e, ids: number[]) => {
      const s = getBootState()
      if (!s.ok) return { ok: false as const, error: s.error }
      const toPath = resolveTrashPath(s.accountId)
      if (!toPath) return { ok: false as const, error: 'no trash folder' }
      const dest = findFolderByPath(s.accountId, toPath)
      if (!dest) return { ok: false as const, error: 'no trash folder' }

      const jobs: PendingMove[] = []
      for (const id of ids) {
        const loc = getMessageLocation(id)
        if (!loc) continue
        if (loc.path === toPath) continue
        jobs.push({
          id,
          accountId: s.accountId,
          fromFolderId: loc.folder_id,
          fromPath: loc.path,
          uid: loc.uid,
          toPath
        })
        moveMessage(id, dest.id)
      }
      if (!jobs.length) return { ok: true as const, batchId: 0, moved: [], toPath }

      const batchId = ++moveBatchSeq
      const timer = setTimeout(() => commitMove(batchId), UNDO_MOVE_MS)
      pendingMoves.set(batchId, { jobs, timer })
      return { ok: true as const, batchId, moved: jobs.map((j) => j.id), toPath }
    }
  )

  // Undo before the window expires: nothing reached the server, so putting the
  // rows back locally is the whole rollback.
  ipcMain.handle('messages:undoMove', (_e, batchId: number) => {
    const batch = pendingMoves.get(batchId)
    if (!batch) return { ok: false as const, error: 'undo window expired' }
    clearTimeout(batch.timer)
    pendingMoves.delete(batchId)
    for (const j of batch.jobs) restoreMessage(j.id, j.fromFolderId, j.uid)
    return { ok: true as const, restored: batch.jobs.map((j) => j.id) }
  })

  ipcMain.handle('folders:list', () => {
    const s = getBootState()
    return s.ok ? listFolders(s.accountId) : []
  })

  ipcMain.handle('settings:get', () => getSettings())

  // The logo is copied into our own store so a later send still works after
  // the user moves or deletes the original file.
  ipcMain.handle('settings:pickLogo', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false as const, error: 'cancelled' }
    const src = r.filePaths[0]
    try {
      const size = statSync(src).size
      if (size > MAX_LOGO_BYTES) {
        return { ok: false as const, error: 'Logo must be under 512 KB' }
      }
      const ext = (extname(src) || '.png').toLowerCase()
      const dest = signatureLogoPath(ext)
      copyFileSync(src, dest)
      setSetting('signature_logo', dest)
      const buf = readFileSync(dest)
      return {
        ok: true as const,
        path: dest,
        dataUrl: `data:${logoMime(ext)};base64,${buf.toString('base64')}`
      }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  // The editor needs pixels to show; the wire format is cid:, not this.
  ipcMain.handle('settings:logoData', () => {
    const path = getSettings().signature_logo
    if (!path) return null
    try {
      const buf = readFileSync(path)
      return `data:${logoMime(extname(path))};base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  })

  ipcMain.handle('settings:clearLogo', () => {
    setSetting('signature_logo', '')
    return { ok: true as const }
  })

  ipcMain.handle('settings:set', (_e, patch: Record<string, string>) => {
    for (const [k, v] of Object.entries(patch)) setSetting(k, v)
    return { ok: true as const }
  })

  ipcMain.handle('folders:unread', () => {
    const s = getBootState()
    return s.ok ? unreadCounts(s.accountId) : {}
  })

  ipcMain.handle('compose:pickAttachments', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections']
    })
    if (r.canceled) return []
    return r.filePaths.map((p) => ({
      path: p,
      filename: basename(p),
      contentType: 'application/octet-stream',
      size: statSync(p).size
    }))
  })

  ipcMain.handle('messages:list', (_e, folderId: number, limit = 100, offset = 0) =>
    listInbox(folderId, limit, offset)
  )

  // Local drafts live outside any folder, so the Drafts view cannot be a plain
  // folder listing — it merges them with the server folder.
  ipcMain.handle('messages:listDrafts', (_e, limit = 100, offset = 0) => {
    const s = getBootState()
    if (!s.ok) return []
    const server = findFolderByPath(s.accountId, 'Drafts')
    return listDrafts(s.accountId, server?.id ?? null, limit, offset)
  })

  // Total rows behind the current view, so the UI can show "Page 2 of 41".
  ipcMain.handle('messages:count', (_e, folderId: number) => {
    const s = getBootState()
    if (!s.ok) return 0
    const drafts = findFolderByPath(s.accountId, 'Drafts')
    return drafts && drafts.id === folderId
      ? countDrafts(s.accountId, drafts.id)
      : countInbox(folderId)
  })

  ipcMain.handle('contacts:search', (_e, query: string, limit = 8) => {
    const s = getBootState()
    return s.ok ? searchContacts(s.accountId, query, limit) : []
  })

  ipcMain.handle('draft:delete', (_e, id: number) => {
    const msg = getMessage(id)
    if (!msg) return { ok: false as const, error: 'draft not found' }
    // A synced server draft is a normal message; only local ones delete freely.
    if (msg.folder_id != null) return { ok: false as const, error: 'server draft' }
    deleteDraft(id)
    return { ok: true as const }
  })

  // Reach past the initial sync window by fetching uids below the oldest local one.
  ipcMain.handle('messages:loadOlder', async (_e, folderId: number, limit = 200) => {
    const s = getBootState()
    if (!s.ok) return { ok: false as const, error: s.error }
    const folder = listFolders(s.accountId).find((f) => f.id === folderId)
    if (!folder) return { ok: false as const, error: 'unknown folder' }
    if (backfilling.has(s.accountId)) return { ok: false as const, error: 'already loading' }
    backfilling.add(s.accountId)
    try {
      const r = await backfillFolder(s.accountId, s.config, folder, limit)
      return { ok: true as const, ...r }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    } finally {
      backfilling.delete(s.accountId)
    }
  })

  ipcMain.handle('messages:search', (_e, query: string, limit = 100) => {
    const s = getBootState()
    return s.ok ? searchMessages(s.accountId, query, limit) : []
  })

  ipcMain.handle('thread:get', (_e, threadId: string) => {
    const s = getBootState()
    return s.ok ? getThread(s.accountId, threadId) : []
  })

  // Mark every message in a thread \Seen. Optimistic: SQLite first, IMAP in the
  // background. Returns the ids whose read-state actually changed so the list
  // can clear their unread dots.
  ipcMain.handle('thread:markRead', (_e, threadId: string) => {
    const s = getBootState()
    if (!s.ok) return { ok: false as const, error: s.error }
    const writer = flagWriterFor(s.accountId, s.config)
    const changed: number[] = []
    for (const m of getThread(s.accountId, threadId)) {
      const next = addFlag(m.id, '\\Seen')
      if (next) {
        changed.push(m.id)
        writer.enqueue({ messageId: m.id, flag: '\\Seen', add: true })
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
          html: inlineCidImages(msg.id, rendered.html),
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
      // Compose is WYSIWYG, so `body` is HTML; the text part is a downgrade.
      const html = payload.body ?? ''
      const fields = {
        to_addrs: payload.to.trim(),
        cc_addrs: payload.cc?.trim() || null,
        bcc_addrs: payload.bcc?.trim() || null,
        subject: payload.subject ?? '',
        body_text: htmlToPlainText(html),
        body_html: html || null,
        in_reply_to: payload.inReplyTo ?? null,
        references_header: payload.references ?? null,
        draft_attachments: payload.attachments?.length
          ? JSON.stringify(payload.attachments)
          : null
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
      const html = payload.body ?? ''
      const text = htmlToPlainText(html)
      updateDraft(payload.draftId, {
        to_addrs: payload.to.trim(),
        cc_addrs: payload.cc?.trim() || null,
        bcc_addrs: payload.bcc?.trim() || null,
        subject: payload.subject ?? '',
        body_text: text,
        body_html: html || null,
        in_reply_to: payload.inReplyTo ?? null,
        references_header: payload.references ?? null,
        draft_attachments: payload.attachments?.length
          ? JSON.stringify(payload.attachments)
          : null
      })
      const row = enqueueOutbox({
        account_id: s.accountId,
        draft_message_id: payload.draftId,
        to_addrs: payload.to.trim(),
        cc_addrs: payload.cc?.trim() || null,
        bcc_addrs: payload.bcc?.trim() || null,
        subject: payload.subject ?? '',
        body_text: text,
        body_html: html || null,
        in_reply_to: payload.inReplyTo ?? null,
        references_header: payload.references ?? null,
        attachments: payload.attachments?.length
          ? JSON.stringify(payload.attachments)
          : null,
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
    if (bodySyncing.has(s.accountId)) return { ok: false as const, error: 'already running' }

    bodySyncing.add(s.accountId)
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
      bodySyncing.delete(s.accountId)
    }
  })

  // Bytes for inline preview. Base64 over IPC rather than a file:// URL, so
  // untrusted attachment content never gets an origin the renderer can reach.
  ipcMain.handle('attachment:data', (_e, id: number) => {
    const row = getAttachment(id)
    if (!row) return { ok: false as const, error: 'attachment not found' }
    const path = attachmentPath(id)
    if (!path) return { ok: false as const, error: 'attachment bytes not stored' }
    try {
      const buf = readFileSync(path)
      // mime is sender-controlled; constrain it so it cannot smuggle extra
      // parameters into the data: URL the preview frame builds.
      const mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(row.mime ?? '')
        ? (row.mime as string)
        : 'application/octet-stream'
      return {
        ok: true as const,
        base64: buf.toString('base64'),
        mime,
        filename: basename(path)
      }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  ipcMain.handle('attachment:save', async (_e, id: number) => {
    const path = attachmentPath(id)
    if (!path) return { ok: false as const, error: 'attachment bytes not stored' }
    const r = await dialog.showSaveDialog({ defaultPath: basename(path) })
    if (r.canceled || !r.filePath) return { ok: true as const, path: null }
    try {
      copyFileSync(path, r.filePath)
      return { ok: true as const, path: r.filePath }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  ipcMain.handle('attachment:open', async (_e, id: number) => {
    const path = attachmentPath(id)
    if (!path) return { ok: false as const, error: 'attachment bytes not stored' }
    const err = await shell.openPath(path)
    return err ? { ok: false as const, error: err } : { ok: true as const }
  })

  // Links from mail open in the real browser, never inside the app frame.
  ipcMain.handle('shell:open', async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) return false
    await shell.openExternal(url)
    return true
  })

  // ---- tasks ----
  // Descriptions are user-authored HTML, but they round-trip through a
  // contenteditable, so sanitise on the way in rather than trusting the
  // renderer to have done it.
  const cleanDescription = (html: string | null | undefined): string | null => {
    const raw = html?.trim()
    if (!raw) return null
    return sanitizeEmailHtml(raw).html
  }

  ipcMain.handle('tasks:list', (_e, query?: TaskQuery) => {
    const s = getBootState()
    return s.ok ? listTasks(s.accountId, query ?? { includeDone: true }) : []
  })

  ipcMain.handle(
    'tasks:create',
    (
      _e,
      input: {
        title: string
        description?: string | null
        due_at?: number | null
        priority?: Priority
      }
    ) => {
      const s = getBootState()
      if (!s.ok) return { ok: false as const, error: s.error }
      const title = input.title?.trim()
      if (!title) return { ok: false as const, error: 'title is required' }
      const task = createTask({
        account_id: s.accountId,
        title,
        description: cleanDescription(input.description),
        due_at: input.due_at ?? null,
        priority: input.priority ?? 0
      })
      return { ok: true as const, task }
    }
  )

  ipcMain.handle('tasks:update', (_e, id: number, patch: TaskPatch) => {
    const next: TaskPatch = { ...patch }
    if ('title' in next) {
      const t = next.title?.trim()
      if (!t) return { ok: false as const, error: 'title cannot be empty' }
      next.title = t
    }
    if ('description' in next) next.description = cleanDescription(next.description)
    const task = updateTask(id, next)
    return task ? { ok: true as const, task } : { ok: false as const, error: 'no such task' }
  })

  ipcMain.handle('tasks:setDone', (_e, id: number, done: boolean) => {
    const task = setTaskDone(id, done)
    return task ? { ok: true as const, task } : { ok: false as const, error: 'no such task' }
  })

  ipcMain.handle('tasks:delete', (_e, id: number) => {
    deleteTask(id)
    return { ok: true as const }
  })

  ipcMain.handle('tasks:countOpen', () => {
    const s = getBootState()
    return s.ok ? countOpenTasks(s.accountId) : 0
  })

  ipcMain.handle('sync:run', () => runSyncFor(getBootState()))
}

/**
 * One guarded sync pass. Exported so the main-process timer and the renderer's
 * sync:run share the same in-flight guard — two concurrent passes over the same
 * account would double-fetch and fight over last_uid.
 */
export async function runSyncFor(
  s: ReturnType<typeof getBootState>
): Promise<
  | { ok: true; folders: number; messages: number; reconciled: number; errors: unknown[]; skipped: boolean }
  | { ok: false; error: string }
> {
  if (!s.ok) return { ok: false, error: s.error }
  // Overlap is normal (timer + focus + boot) — skip quietly, not an error.
  if (syncing.has(s.accountId)) {
    return { ok: true, folders: 0, messages: 0, reconciled: 0, errors: [], skipped: true }
  }

  syncing.add(s.accountId)
  try {
    const result = await syncAccount(s.accountId, s.config, {
      // Server state must not clobber a local flag change still in the queue.
      pendingFlagIds: flagWriters.get(s.accountId)?.pendingIds(),
      onProgress: (p) => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('sync:progress', p)
      }
    })
    // One-time threading repair, in the background: it re-reads every header
    // in the mailbox and must not delay the list the user is waiting on.
    if (!rethreadDone(s.accountId)) {
      void repairThreading(s.accountId, s.config)
        .then((r) => {
          if (r.skipped || !r.updated) return
          for (const w of BrowserWindow.getAllWindows())
            w.webContents.send('threading:repaired', { updated: r.updated })
        })
        .catch((e) => console.error('[rethread] failed:', e))
    }
    return { ok: true, ...result, skipped: false }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    syncing.delete(s.accountId)
  }
}
