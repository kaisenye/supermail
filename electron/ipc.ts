import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename, extname } from 'path'
import { copyFileSync, readFileSync, statSync } from 'fs'
import { attachmentPath, signatureLogoPath } from '../src/core/store/attachments.js'
import { undoWindowMs } from '../src/core/triage/undoWindow.js'
import { planMoves, type PlannedMove } from '../src/core/triage/movePlan.js'
import { dropFiredReminders, type ReminderSnapshot } from '../src/core/triage/reminders.js'
import { rollbackMoves } from '../src/core/triage/moveUndo.js'
import {
  backfillFolder,
  listHeadersDone,
  repairListHeaders,
  repairThreading,
  rethreadDone,
  syncAccount
} from '../src/core/sync/syncEngine.js'
import { ensureBody } from '../src/core/sync/fetchBody.js'
import { shouldSyncFolder } from '../src/core/sync/folderFilter.js'
import { syncBodies } from '../src/core/sync/bodySync.js'
import { FlagWriter } from '../src/core/sync/flagWriter.js'
import { MoveWriter } from '../src/core/sync/moveWriter.js'
import type { AccountConfig } from '../src/core/accounts/config.js'
import { listPresets, presetFor } from '../src/core/accounts/presets.js'
import { verifyAccount } from '../src/core/accounts/verify.js'
import {
  displayNameFor,
  forgetAccount,
  rememberDisplayName,
  saveAccount,
  saveOAuthAccount,
  toConfig,
  type NewAccountInput
} from '../src/core/accounts/manage.js'
import { authUrl, createPkce, exchangeCode, primeAccessToken } from '../src/core/accounts/oauth.js'
import { waitForRedirect } from '../src/core/accounts/oauthFlow.js'
import { startAccountWorkers, stopAccountWorkers } from './workers.js'
import { syncAllAccounts } from './syncAll.js'
import { runBackfillExclusive } from './backfillLock.js'
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
  createDraft,
  searchContacts,
  accountOfMessage,
  deleteDraft,
  folderByRole,
  getAttachment,
  getMessage,
  getSettings,
  setSetting,
  groupByAccount,
  getThread,
  listAttachments,
  listDrafts,
  listInlineParts,
  listFolders,
  moveMessage,
  removeFlag,
  searchMessages,
  toggleFlag,
  updateDraft
} from '../src/core/store/repo.js'
import { countView, listView, repairListDrift, unreadCounts } from '../src/core/store/listRows.js'
import type { MoveTarget } from '../src/core/store/folderRoles.js'
import { sanitizeEmailHtml, textToHtml } from '../src/core/render/sanitize.js'
import { htmlToPlainText, stripComposeMarkers } from '../src/core/send/mime.js'
import {
  cancelOutbox,
  enqueueOutbox,
  listScheduledOutbox,
  remindAtError
} from '../src/core/send/outbox.js'
import {
  addAccount as addAccountToState,
  clearNeedsReauth,
  getAccount,
  getBootState,
  getBootStatus,
  listAccounts,
  removeAccount as removeAccountFromState,
  setActiveAccount,
  type LiveAccount
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

// All keyed by accountId — a shared flag would let one account's in-flight
// sync suppress another's, and a shared writer would target the wrong server.
const syncing = new Set<number>()
/** Accounts with a one-time header repair running, so a second sync does not start another. */
const repairing = new Set<number>()
const bodySyncing = new Set<number>()
const flagWriters = new Map<number, FlagWriter>()
const moveWriters = new Map<number, MoveWriter>()

export function flagWriterFor(accountId: number, config: AccountConfig): FlagWriter {
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
    w = new MoveWriter(accountId, config)
    moveWriters.set(accountId, w)
  }
  return w
}

/** Replays IMAP moves a previous run accepted but never confirmed. */
export function resumePendingMoves(accountId: number, config: AccountConfig): void {
  moveWriterFor(accountId, config).resume()
}

/**
 * The live account that owns a message. Handlers acting on a message must use
 * this rather than the active account: the user can switch accounts while an
 * old row is still on screen, and a unified inbox will mix accounts.
 */
function ownerOf(messageId: number): LiveAccount | null {
  const accountId = accountOfMessage(messageId)
  return accountId === null ? null : getAccount(accountId)
}

/** The account a renderer call names, or the active one when it names none. */
function accountFor(accountId?: number | null): LiveAccount | null {
  if (accountId != null) return getAccount(accountId)
  const s = getBootState()
  return s.ok ? getAccount(s.accountId) : null
}

let moveBatchSeq = 0
const pendingMoves = new Map<
  number,
  {
    jobs: PlannedMove[]
    /** Fired reminders the move dropped; undo puts them back. */
    reminders: ReminderSnapshot[]
    timer: ReturnType<typeof setTimeout>
  }
>()

/**
 * Source uids of held moves out of one mailbox. The server still has them
 * there until commitMove, so a backfill or server search must not store them again.
 */
export function heldSourceUids(accountId: number, fromPath: string): number[] {
  const out: number[] = []
  for (const b of pendingMoves.values())
    for (const j of b.jobs) if (j.accountId === accountId && j.fromPath === fromPath) out.push(j.uid)
  return out
}


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
      toPath: j.toPath,
      uidValidity: j.uidValidity
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
  /** The account it sends from (a unified-inbox reply); null = the active one. */
  accountId?: number | null
}

interface ComposeAttachment {
  path: string
  filename: string
  contentType: string
  size: number
}

interface QueueSendPayload extends DraftPayload {
  draftId: number
  /** null = now, after the undo window. */
  sendAt: number | null
  attachments?: ComposeAttachment[]
  /** "Remind me if no reply": saved as a reminder once the mail is sent. */
  remindAt?: number | null
  /** Scheduled send only: cancel it if someone replies first. */
  cancelOnReply?: boolean
}

/**
 * Applies moves to SQLite now and holds the IMAP MOVEs for the undo window.
 * Exported for triage handlers (Get me to zero) so every move shares one hold
 * and one undo path.
 */
export function holdMove(
  ids: number[],
  target: MoveTarget
):
  | { ok: true; batchId: number; moved: number[]; holdMs: number }
  | { ok: false; error: string } {
  const r = planMoves(ids, target, (accountId) => getAccount(accountId)?.config.provider ?? null)
  if (!r.ok) return r
  const holdMs = undoWindowMs(getSettings())
  if (!r.plan.length) return { ok: true, batchId: 0, moved: [], holdMs }
  // Acting on a fired reminder's thread is what it was waiting for. By thread:
  // the reminder may sit on a message this move does not touch (the Sent copy).
  const reminders = dropFiredReminders(r.plan.map((p) => p.id))
  for (const p of r.plan) moveMessage(p.id, p.toFolderId)
  const batchId = ++moveBatchSeq
  const timer = setTimeout(() => commitMove(batchId), holdMs)
  pendingMoves.set(batchId, { jobs: r.plan, reminders, timer })
  return { ok: true, batchId, moved: r.plan.map((p) => p.id), holdMs }
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

  // "Continue with Google / Microsoft": consent in the system browser, then
  // the same verify-before-save path as a password account. Re-signing in to
  // an address already present updates it in place, which is also re-auth.
  // `expectedEmail` is set by the sign-in-again banner: the reconnect must be
  // for that address, not whichever account the browser happens to pick.
  ipcMain.handle(
    'account:oauth',
    async (_e, provider: 'google' | 'microsoft', expectedEmail?: string) => {
      try {
        const { verifier, challenge } = createPkce()
        const { code, redirectUri } = await waitForRedirect({
          host: provider === 'google' ? '127.0.0.1' : 'localhost',
          buildUrl: (redirect, state) => authUrl(provider, redirect, challenge, state, expectedEmail),
          openUrl: (url) => shell.openExternal(url)
        })
        const t = await exchangeCode(provider, code, verifier, redirectUri)
        if (!t.email) return { ok: false as const, error: 'The provider did not return an email address.' }
        // Checked before anything is saved, so a wrong pick leaves no new account.
        if (expectedEmail && t.email.toLowerCase() !== expectedEmail.toLowerCase()) {
          return {
            ok: false as const,
            error: `You signed in as ${t.email}. Sign in as ${expectedEmail} to reconnect it.`
          }
        }

        const existing = storedAccounts().find((a) => a.email.toLowerCase() === t.email!.toLowerCase())
        const { account, config } = saveOAuthAccount({
          email: t.email,
          // The From: name lives in settings (displayNameFor) and is edited there.
          name: displayNameFor(existing?.id ?? -1),
          provider: provider === 'google' ? 'gmail' : 'microsoft',
          oauthProvider: provider,
          refreshToken: t.refreshToken
        })
        if (config.auth.kind === 'oauth2') primeAccessToken(config.auth.ref, t.accessToken, t.expiresAt)

        const check = await verifyAccount(config)
        if (!check.ok) {
          // A brand-new account that cannot connect must not linger half-added.
          if (!existing) {
            forgetAccount(account)
            deleteAccount(account.id)
          }
          return { ok: false as const, error: check.message ?? 'connection failed' }
        }
        // A re-auth replaces the live config so pools pick up the new token ref.
        // Overwriting in place keeps the sidebar order and the active account;
        // remove-then-add would hand "active" to whichever account is first.
        if (getAccount(account.id)) stopAccountWorkers(account.email)
        addAccountToState({ accountId: account.id, email: account.email, config })
        clearNeedsReauth(account.email)
        // Only a new account becomes active. A re-auth must not retarget
        // compose/send (getBootState) away from the account the renderer shows,
        // since nothing reloads the window here.
        if (!existing) setActiveAccount(account.id)
        startAccountWorkers(config)
        return { ok: true as const, accountId: account.id, email: account.email }
      } catch (e) {
        return { ok: false as const, error: (e as Error).message }
      }
    }
  )

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
    const acct = ownerOf(id)
    if (!acct) return { ok: false as const, error: 'message not found' }
    const next = toggleFlag(id, flag)
    const nowHas = next.some((f) => f.toLowerCase() === flag.toLowerCase())
    flagWriterFor(acct.accountId, acct.config).enqueue({ messageId: id, flag, add: nowHas })
    return { ok: true as const, flags: next }
  })

  // Bulk set/clear a flag (read, unread, star). Returns per-id new flags.
  ipcMain.handle(
    'messages:setFlag',
    (_e, ids: number[], flag: string, add: boolean) => {
      const updated: { id: number; flags: string[] }[] = []
      for (const [accountId, own] of groupByAccount(ids)) {
        const acct = getAccount(accountId)
        if (!acct) continue
        const writer = flagWriterFor(accountId, acct.config)
        for (const id of own) {
          const next = add ? addFlag(id, flag) : removeFlag(id, flag)
          if (!next) continue
          writer.enqueue({ messageId: id, flag, add })
          updated.push({ id, flags: next })
        }
      }
      return { ok: true as const, updated }
    }
  )

  // Optimistic local move now; the IMAP MOVE is held for the undo window so undo
  // is a local rollback rather than a compensating reverse MOVE on the server.
  ipcMain.handle('messages:move', (_e, ids: number[], target: MoveTarget) => holdMove(ids, target))

  // Undo before the window expires: nothing reached the server, so putting the
  // rows back locally is the whole rollback.
  // One transaction, run while the batch is still pending: if it fails nothing
  // changed locally and the batch's timer still commits the move, so SQLite and
  // the server never split.
  ipcMain.handle('messages:undoMove', (_e, batchId: number) => {
    const batch = pendingMoves.get(batchId)
    if (!batch) return { ok: false as const, error: 'undo window expired' }
    try {
      rollbackMoves(batch.jobs, batch.reminders)
    } catch (e) {
      return { ok: false as const, error: `Undo failed: ${(e as Error).message}` }
    }
    clearTimeout(batch.timer)
    pendingMoves.delete(batchId)
    return { ok: true as const, restored: batch.jobs.map((j) => j.id) }
  })

  // Gmail labels and All Mail are not synced, so listing them would show
  // folders that stay empty forever.
  ipcMain.handle('folders:list', () => {
    const s = getBootState()
    return s.ok
      ? listFolders(s.accountId).filter((f) => shouldSyncFolder(s.config.provider, f))
      : []
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

  ipcMain.handle(
    'messages:list',
    (_e, folderId: number, limit = 100, offset = 0, query = '') =>
      listView(folderId, { limit, offset, query })
  )

  // Local drafts live outside any folder, so the Drafts view cannot be a plain
  // folder listing — it merges them with the server folder.
  ipcMain.handle('messages:listDrafts', (_e, limit = 100, offset = 0) => {
    const s = getBootState()
    if (!s.ok) return []
    const server = folderByRole(s.accountId, 'drafts')
    return listDrafts(s.accountId, server?.id ?? null, limit, offset)
  })

  // Total rows behind the current view, so the UI can show "Page 2 of 41".
  ipcMain.handle('messages:count', (_e, folderId: number, query = '') => {
    const s = getBootState()
    if (!s.ok) return 0
    const drafts = folderByRole(s.accountId, 'drafts')
    return drafts && drafts.id === folderId
      ? countDrafts(s.accountId, drafts.id)
      : countView(folderId, { query })
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
    try {
      // Waits out a history-worker page rather than failing: the user asked.
      const r = await runBackfillExclusive(
        s.accountId,
        () => backfillFolder(s.accountId, s.config, folder, limit, () => heldSourceUids(s.accountId, folder.path)),
        { wait: true }
      )
      return r ? { ok: true as const, ...r } : { ok: false as const, error: 'already loading' }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  ipcMain.handle('messages:search', (_e, query: string, limit = 100) => {
    const s = getBootState()
    return s.ok ? searchMessages(s.accountId, query, limit) : []
  })

  // Thread ids collide across accounts, so the caller says whose thread it is
  // (the row's account_id); the active account is only the default.
  ipcMain.handle('thread:get', (_e, threadId: string, accountId?: number) => {
    const a = accountFor(accountId)
    return a ? getThread(a.accountId, threadId) : []
  })

  // Mark every message in a thread \Seen. Optimistic: SQLite first, IMAP in the
  // background. Returns the ids whose read-state actually changed so the list
  // can clear their unread dots.
  /**
   * Whole-thread, mirroring markRead: reading marks every message seen, so
   * un-reading only the newest would be undone the moment it reopens.
   */
  ipcMain.handle('thread:markUnread', (_e, threadIds: string[], accountId?: number) => {
    const a = accountFor(accountId)
    if (!a) return { ok: false as const, error: 'account not found' }
    const writer = flagWriterFor(a.accountId, a.config)
    const changed: number[] = []
    for (const threadId of threadIds) {
      for (const m of getThread(a.accountId, threadId)) {
        const next = removeFlag(m.id, '\\Seen')
        if (!next) continue
        changed.push(m.id)
        writer.enqueue({ messageId: m.id, flag: '\\Seen', add: false })
      }
    }
    return { ok: true as const, changed }
  })

  ipcMain.handle('thread:markRead', (_e, threadId: string, accountId?: number) => {
    const a = accountFor(accountId)
    if (!a) return { ok: false as const, error: 'account not found' }
    const writer = flagWriterFor(a.accountId, a.config)
    const changed: number[] = []
    for (const m of getThread(a.accountId, threadId)) {
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
      const acct = ownerOf(messageId)
      if (!acct) return { ok: false as const, error: 'message not found' }
      try {
        const msg = await ensureBody(acct.accountId, acct.config, messageId)
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

  // Warms the bodies either side of the open thread, so auto-advance after a
  // triage opens the next one from SQLite instead of waiting on IMAP.
  ipcMain.handle('messages:prefetchBodies', async (_e, ids: number[]) => {
    for (const id of ids.slice(0, 4)) {
      const acct = ownerOf(id)
      if (!acct) continue
      try {
        await ensureBody(acct.accountId, acct.config, id)
      } catch {
        // Best effort: opening the message retries and reports properly.
      }
    }
  })

  ipcMain.handle('message:get', (_e, id: number) => getMessage(id))

  ipcMain.handle('compose:saveDraft', (_e, payload: DraftPayload) => {
    const a = accountFor(payload.accountId)
    if (!a) return { ok: false as const, error: 'account not found' }
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
          account_id: a.accountId,
          from_addr: a.config.email,
          ...fields
        })
      }
      return { ok: true as const, draftId }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  // A reply from the unified inbox must leave from the account that received the mail.
  ipcMain.handle('compose:queueSend', (_e, payload: QueueSendPayload) => {
    const a = accountFor(payload.accountId)
    if (!a) return { ok: false as const, error: 'account not found' }
    if (!payload.to?.trim()) return { ok: false as const, error: 'missing recipients' }
    try {
      const sendAt = payload.sendAt ?? Date.now() + undoWindowMs(getSettings())
      const remindErr = remindAtError(payload.remindAt, sendAt)
      if (remindErr) return { ok: false as const, error: remindErr }
      const html = payload.body ?? ''
      const text = htmlToPlainText(html)
      // The draft keeps the compose markers; the wire copy does not.
      const wireHtml = stripComposeMarkers(html)
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
        account_id: a.accountId,
        draft_message_id: payload.draftId,
        to_addrs: payload.to.trim(),
        cc_addrs: payload.cc?.trim() || null,
        bcc_addrs: payload.bcc?.trim() || null,
        subject: payload.subject ?? '',
        body_text: text,
        body_html: wireHtml || null,
        in_reply_to: payload.inReplyTo ?? null,
        references_header: payload.references ?? null,
        attachments: payload.attachments?.length
          ? JSON.stringify(payload.attachments)
          : null,
        send_at: sendAt,
        remind_at: payload.remindAt ?? null,
        cancel_on_reply: payload.cancelOnReply && payload.inReplyTo ? 1 : 0
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
    // Every live account: a reply from All inboxes queues under the account
    // that received the mail, which may not be the active one.
    const emails = new Map(listAccounts().map((a) => [a.accountId, a.email]))
    return listScheduledOutbox([...emails.keys()], Date.now() + undoWindowMs(getSettings())).map(
      (r) => ({
        id: r.id,
        to_addrs: r.to_addrs,
        subject: r.subject,
        send_at: r.send_at,
        status: r.status,
        from_addr: emails.get(r.account_id) ?? null
      })
    )
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
    // mailto: too — the editor accepts those, and rejecting them here made a
    // mailto link silently do nothing.
    if (!/^(https?:\/\/|mailto:)/i.test(url)) return false
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

  // An IDLE push from an account that is not on screen syncs that account.
  ipcMain.handle('sync:runAccount', (_e, email: string) => {
    const a = listAccounts().find((x) => x.email.toLowerCase() === String(email).toLowerCase())
    if (!a) return { ok: false as const, error: 'no such account' }
    return runSyncFor({ ok: true, accountId: a.accountId, email: a.email, config: a.config })
  })

  // The unified inbox shows every account, so its refresh syncs every account.
  ipcMain.handle('sync:runAll', () =>
    syncAllAccounts(listAccounts(), (a) =>
      runSyncFor({ ok: true, accountId: a.accountId, email: a.email, config: a.config })
    )
  )
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
    // The read model is trigger-maintained; this catches anything that slipped
    // past the triggers (a crash mid-rebuild, a manual DB edit).
    const drifted = repairListDrift(s.accountId)
    if (drifted.length) console.warn(`[listRows] repaired drift in folders ${drifted.join(', ')}`)
    // The server just answered, so moves deferred while offline can go now.
    resumePendingMoves(s.accountId, s.config)
    // One-time header repairs, in the background: each re-reads every header
    // in the mailbox and must not delay the list the user is waiting on. Run
    // one after the other so they never hold two extra connections at once.
    if (!repairing.has(s.accountId) && (!rethreadDone(s.accountId) || !listHeadersDone(s.accountId))) {
      const { accountId, config } = s
      repairing.add(accountId)
      void (async () => {
        try {
          const r = await repairThreading(accountId, config)
          if (!r.skipped && r.updated) {
            for (const w of BrowserWindow.getAllWindows())
              w.webContents.send('threading:repaired', { updated: r.updated })
          }
        } catch (e) {
          console.error('[rethread] failed:', e)
        }
        try {
          await repairListHeaders(accountId, config)
        } catch (e) {
          console.error('[listHeaders] backfill failed:', e)
        }
      })().finally(() => repairing.delete(accountId))
    }
    return { ok: true, ...result, skipped: false }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    syncing.delete(s.accountId)
  }
}
