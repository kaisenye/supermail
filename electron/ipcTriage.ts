import { ipcMain, shell } from 'electron'
import { doneRole } from '../src/core/store/folderRoles.js'
import { archiveSetup } from '../src/core/triage/archiveSetup.js'
import {
  addMessageLabel,
  gmailLabelChoices,
  labelsForMessages,
  removeMessageLabel
} from '../src/core/store/labels.js'
import {
  folderByRole,
  getMessage,
  getSettings,
  groupByAccount,
  listFolders,
  setFolderRole,
  threadMatesInFolder,
  upsertFolder
} from '../src/core/store/repo.js'
import { setMute, setVip, toggleMute, toggleVip } from '../src/core/triage/localRules.js'
import {
  clearReminders,
  listReminderRows,
  restoreReminders,
  setReminder,
  type ReminderSnapshot
} from '../src/core/triage/reminders.js'
import { undoWindowMs } from '../src/core/triage/undoWindow.js'
import { describePlan, oneClickPost, planUnsubscribe, runUnsubscribe } from '../src/core/triage/unsubscribe.js'
import { zeroCandidates, type ZeroOptions } from '../src/core/triage/zero.js'
import { enqueueOutbox } from '../src/core/send/outbox.js'
import { deleteSplit, listSplits, saveSplit, splitCounts } from '../src/core/store/splits.js'
import { getPool } from '../src/core/sync/pool.js'
import { flagWriterFor, holdMove } from './ipc.js'
import { getAccount, getBootState } from './state.js'

/**
 * Phase 2 triage handlers. Kept out of ipc.ts, which owns sync, compose and
 * the move hold; anything here that moves mail calls ipc.ts's holdMove.
 */
export function registerTriageIpc(): void {
  ipcMain.handle('splits:list', () => listSplits())

  ipcMain.handle('splits:save', (_e, input: { id?: string; name: string; query: string }) => {
    try {
      return { ok: true as const, split: saveSplit(input) }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  ipcMain.handle('splits:delete', (_e, id: string) => {
    deleteSplit(id)
    return { ok: true as const }
  })

  ipcMain.handle('splits:counts', (_e, folderId: number, extraQuery = '') =>
    splitCounts(folderId, extraQuery)
  )

  // Settings asks before anything is created on the server: the reverted
  // snooze created mailboxes unasked, and that is the mistake not to repeat.
  ipcMain.handle('triage:archiveStatus', () => {
    const s = getBootState()
    if (!s.ok) return { ok: false as const, error: s.error }
    const role = doneRole(s.config.provider)
    return {
      ok: true as const,
      ...archiveSetup(s.config.provider, !!folderByRole(s.accountId, role)),
      host: s.config.imapHost
    }
  })

  ipcMain.handle('triage:createArchive', async () => {
    const s = getBootState()
    if (!s.ok) return { ok: false as const, error: s.error }
    const role = doneRole(s.config.provider)
    const plan = archiveSetup(s.config.provider, !!folderByRole(s.accountId, role))
    if (plan.hasArchive) return { ok: true as const }
    // Gmail: Done needs All Mail, which no "Archive" label can stand in for.
    if (!plan.canCreate) return { ok: false as const, error: plan.reason ?? 'cannot create' }
    try {
      // The server may prefix a namespace (INBOX.Archive); keep the path it returns.
      const created = await getPool(s.config).withConnection((c) => c.mailboxCreate('Archive'))
      upsertFolder({ account_id: s.accountId, name: 'Archive', path: created.path, uidvalidity: null })
      setFolderRole(s.accountId, created.path, role)
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  // Remind me is local only: nothing moves on the server. Row ids act on
  // their owning account, not the active one.
  // Undo needs what each target had before: a reschedule goes back to the
  // old reminder (prev), a fresh one is cleared (fresh row ids).
  ipcMain.handle('reminders:set', (_e, ids: number[], remindAt: number, ifNoReply: boolean) => {
    const set: number[] = []
    const fresh: number[] = []
    const prev: ReminderSnapshot[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      const m = getMessage(id)
      if (!m?.message_id) continue
      set.push(id)
      // Two rows of one message: the second would see the first's new values as "before".
      const key = `${m.account_id}:${m.message_id}`
      if (seen.has(key)) continue
      seen.add(key)
      const before = setReminder({
        accountId: m.account_id,
        messageId: m.message_id,
        subject: m.subject,
        remindAt,
        ifNoReply
      })
      if (before) prev.push(before)
      else fresh.push(id)
    }
    return { ok: true as const, set, fresh, prev, holdMs: undoWindowMs(getSettings()) }
  })

  ipcMain.handle('reminders:restore', (_e, rows: ReminderSnapshot[]) => {
    restoreReminders(rows)
    return { ok: true as const }
  })

  ipcMain.handle('reminders:clear', (_e, ids: number[]) => {
    const messages = ids.map((id) => getMessage(id)).filter((m) => m !== undefined)
    return { ok: true as const, cleared: clearReminders(messages), holdMs: undoWindowMs(getSettings()) }
  })

  ipcMain.handle('reminders:list', () => {
    const s = getBootState()
    return s.ok ? listReminderRows(s.accountId) : []
  })

  // Mute and VIP are local rules: nothing changes on the server.
  // Every target ends in one state; `set` forces it (undo passes back `changed`).
  ipcMain.handle('triage:mute', (_e, ids: number[], set?: boolean) => {
    if (set !== undefined) {
      return { ok: true as const, muted: set, changed: setMute(ids, set), holdMs: 0 }
    }
    const r = toggleMute(ids)
    return r === null
      ? { ok: false as const, error: 'This message cannot be muted' }
      : { ok: true as const, ...r, holdMs: undoWindowMs(getSettings()) }
  })

  ipcMain.handle('triage:vip', (_e, ids: number[], set?: boolean) => {
    if (set !== undefined) {
      return { ok: true as const, vip: set, changed: setVip(ids, set), holdMs: 0 }
    }
    const r = toggleVip(ids)
    return r === null
      ? { ok: false as const, error: 'No sender' }
      : { ok: true as const, ...r, holdMs: undoWindowMs(getSettings()) }
  })

  ipcMain.handle('labels:choices', () => {
    const s = getBootState()
    return s.ok && s.config.provider === 'gmail' ? gmailLabelChoices(listFolders(s.accountId)) : []
  })

  ipcMain.handle('labels:forMessages', (_e, ids: number[]) => labelsForMessages(ids))

  // Optimistic like flags: SQLite now, STORE ±X-GM-LABELS in the background.
  // Every owning account is checked first so a mixed selection changes nothing.
  ipcMain.handle('messages:label', (_e, ids: number[], label: string, add: boolean) => {
    const groups = [...groupByAccount(ids)].map(([accountId, own]) => ({
      accountId,
      own,
      acct: getAccount(accountId)
    }))
    if (groups.some((g) => g.acct && g.acct.config.provider !== 'gmail'))
      return { ok: false as const, error: 'Labels are Gmail only' }
    for (const { accountId, own, acct } of groups) {
      if (!acct) continue
      const writer = flagWriterFor(accountId, acct.config)
      for (const rowId of own) {
        for (const id of threadMatesInFolder(rowId)) {
          const changed = add
            ? addMessageLabel(id, accountId, label)
            : removeMessageLabel(id, accountId, label)
          if (changed) writer.enqueue({ messageId: id, flag: label, add, useLabels: true })
        }
      }
    }
    return { ok: true as const }
  })

  // Planned again in run: the renderer only ever sends a message id, never a URL.
  ipcMain.handle('unsubscribe:plan', (_e, rowId: number) => {
    const m = getMessage(rowId)
    const plan = m ? planUnsubscribe(m.list_unsubscribe, !!m.unsubscribe_one_click) : null
    if (!m || !plan) return { ok: false as const, error: 'This sender offers no unsubscribe link' }
    return { ok: true as const, sender: m.from_name || m.from_addr || 'this sender', description: describePlan(plan) }
  })

  ipcMain.handle('unsubscribe:run', async (_e, rowId: number) => {
    const m = getMessage(rowId)
    const plan = m ? planUnsubscribe(m.list_unsubscribe, !!m.unsubscribe_one_click) : null
    if (!m || !plan) return { ok: false as const, error: 'This sender offers no unsubscribe link' }
    return runUnsubscribe(plan, {
      post: (url) => oneClickPost(url),
      // Through the outbox, from the account that received the mail.
      sendMail: (to, subject, body) => {
        enqueueOutbox({ account_id: m.account_id, draft_message_id: null, to_addrs: to, subject, body_text: body, send_at: Date.now() })
      },
      openUrl: (url) => shell.openExternal(url)
    })
  })

  ipcMain.handle('triage:zero', (_e, folderId: number, opts: ZeroOptions, dryRun: boolean) => {
    const ids = zeroCandidates(folderId, opts)
    if (dryRun) return { ok: true as const, count: ids.length }
    return holdMove(ids, { role: 'archive' })
  })
}
