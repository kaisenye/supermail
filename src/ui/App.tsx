import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AccountSummary, ScheduledSend, Split } from '../../electron/preload'
import type { MessageListRow } from '../core/store/types'
import { emptyCompose, REMINDERS_VIEW_ID, useStore, type ComposeAttachment } from './store'
import { useHotkeys, type Mode } from './hooks/useHotkeys'
import { useKeySequences } from './hooks/useKeySequences'
import {
  buildBindings,
  buildChords,
  buildPaletteActions,
  buildSequences,
  withTiming,
  type Handlers
} from './commands'
import { useCommandChord } from './hooks/useCommandChord'
import { MessageList } from './views/MessageList'
import { ActionBar } from './views/ActionBar'
import { SplitBar } from './views/SplitBar'
import { Sidebar } from './views/Sidebar'
import { Thread } from './views/Thread'
import { CommandPalette, type PaletteAction } from './views/CommandPalette'
import { Compose } from './views/Compose'
import { UndoToast } from './views/UndoToast'
import { RemindPicker } from './views/RemindPicker'
import { Picker, type PickerItem } from './views/Picker'
import { ConfirmDialog } from './views/ConfirmDialog'
import { ZeroModal } from './views/ZeroModal'
import { ZeroState } from './views/ZeroState'
import { Settings } from './views/Settings'
import { Tasks } from './views/Tasks'
import { ShortcutHelp } from './views/ShortcutHelp'
import { Onboarding } from './views/Onboarding'
import { PenSquare, Plus } from 'lucide-react'
import { folderLabel, isFlagged, isUnread } from './format'
import { goDoneTarget, reloadFolders } from './folders'
import { doneAction, undoRepaint, viewKey, type ViewKey } from './viewScope'
import { appMode, baseMode } from './appMode'
import { openThreadTarget } from './threadTarget'
import { viewQuery, type ChipId } from './chips'
import { nextSplitId, resolveSplitId } from './splitNav'
import { dayKey, isInboxZero, nextStreak } from './streak'
import type { FolderRole, MoveTarget } from '../core/store/folderRoles'
import { buildForwardBody, buildReplyBody } from './quote'
import { applyTheme, isTheme, type Theme } from './theme'
import { latestOnly } from './latest'
import './styles/app.css'

/** Sentinel from main: no account connected yet, as opposed to a real fault. */
const NO_ACCOUNT = 'no account connected'

/** Main's error when Done finds no archive folder (Exmail has none until Settings makes one). */
const NO_ARCHIVE = 'Done needs an Archive folder. Create one in Settings → Done folder.'

/** Folders holding your own mail, where "from" is always you. */
const OUTGOING_ROLES: FolderRole[] = ['sent', 'drafts']

const PAGE_SIZE = 50

/** A picker or dialog over the list. Keys inside it are its own, so mode is 'modal'. */
type Overlay =
  | { kind: 'remind'; fromThread: boolean; hasReminder: boolean }
  | { kind: 'move'; fromThread: boolean }
  | { kind: 'label'; ids: number[]; items: PickerItem[] }
  | { kind: 'unsubscribe'; id: number; sender: string; description: string }
  | { kind: 'zero'; folderId: number }

function replySubject(subject: string | null): string {
  const s = (subject ?? '').trim()
  if (!s) return 'Re: '
  return /^re:/i.test(s) ? s : `Re: ${s}`
}

function forwardSubject(subject: string | null): string {
  const s = (subject ?? '').trim()
  if (!s) return 'Fwd: '
  return /^fwd?:/i.test(s) ? s : `Fwd: ${s}`
}

export default function App() {
  const {
    email,
    bootError,
    folders,
    activeFolderId,
    rows,
    selectedIndex,
    checkedIds,
    syncing,
    syncLabel,
    openThread,
    openThreadView,
    closeThread,
    updateRowFlags,
    markRowSeen,
    removeRows,
    setBoot,
    setFolders,
    setActiveFolder,
    setRows,
    setPageRows,
    restoreRows,
    setSelectedIndex,
    moveSelection,
    toggleChecked,
    checkRange,
    setCheckedAll,
    clearChecked,
    setSync,
    syncError,
    setSyncError,
    actionError,
    setActionError,
    setSyncedOnce,
    hasSyncedOnce,
    paletteOpen,
    openPalette,
    closePalette,
    compose,
    openCompose,
    closeCompose,
    undo,
    setUndo,
    unread,
    setUnread,
    loadingMore,
    setLoadingMore,
    page,
    setPage,
    totalRows,
    setTotalRows,
    splitId,
    chip,
    groupByDate,
    setSplit,
    setChip,
    setGroupByDate,
    extendSelection
  } = useStore()

  // Expanded inline in the palette; reset on close so it never shows stale rows.
  const [scheduled, setScheduled] = useState<ScheduledSend[]>([])
  useEffect(() => {
    if (!paletteOpen) setScheduled([])
  }, [paletteOpen])

  const refreshUnread = useCallback(async () => {
    setUnread(await window.api.unreadCounts())
  }, [setUnread])

  /** Offers `run` as the undo for `holdMs`, the window main is holding the action for. */
  const pushUndo = useCallback(
    (label: string, holdMs: number, run: () => Promise<void>) => {
      if (holdMs > 0) setUndo({ label, expiresAt: Date.now() + holdMs, run })
    },
    [setUndo]
  )

  const runUndo = useCallback(async () => {
    const u = useStore.getState().undo
    if (!u || Date.now() > u.expiresAt) return
    setUndo(null)
    await u.run()
  }, [setUndo])

  /** Drafts live outside any folder, so that view has its own query. */
  const isDraftsFolder = useCallback((folderId: number): boolean => {
    const f = useStore.getState().folders.find((x) => x.id === folderId)
    return f?.role === 'drafts'
  }, [])

  const showRecipient = useMemo(() => {
    const f = folders.find((x) => x.id === activeFolderId)
    return f?.role ? OUTGOING_ROLES.includes(f.role) : false
  }, [folders, activeFolderId])

  const [accounts, setAccounts] = useState<AccountSummary[]>([])
  const [activeAccountId, setActiveAccountId] = useState<number | null>(null)
  const [addingAccount, setAddingAccount] = useState(false)
  const [reauthEmail, setReauthEmail] = useState<string | null>(null)
  useEffect(() => window.api.onReauthNeeded(setReauthEmail), [])

  const [reauthBusy, setReauthBusy] = useState(false)
  const reauthBusyRef = useRef(false)
  const reauth = useCallback(async () => {
    // One browser round-trip at a time; a second click would race the first.
    if (!reauthEmail || reauthBusyRef.current) return
    reauthBusyRef.current = true
    setReauthBusy(true)
    try {
      // From the account itself, not the domain: Google Workspace and M365
      // tenants use custom domains.
      const acct = accounts.find((a) => a.email.toLowerCase() === reauthEmail.toLowerCase())
      const res = await window.api.accountOAuth(
        acct?.provider === 'gmail' ? 'google' : 'microsoft',
        reauthEmail
      )
      if (res.ok) setReauthEmail(null)
      else setSyncError(res.error)
    } finally {
      reauthBusyRef.current = false
      setReauthBusy(false)
    }
  }, [reauthEmail, accounts, setSyncError])
  /**
   * Reload rather than refetch: folders, rows, counts, unread and any open
   * thread all belong to the old account, and a reload cannot leave one stale.
   */
  const switchAccount = useCallback(async (accountId: number) => {
    const res = await window.api.accountSetActive(accountId)
    if (res.ok) window.location.reload()
  }, [])

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  // Tasks replaces the mail pane rather than overlaying it: it is a separate
  // place to be, not a modal on top of the inbox.
  const [tasksOpen, setTasksOpen] = useState(false)
  const [creatingTask, setCreatingTask] = useState(false)
  const [openTasks, setOpenTasks] = useState(0)

  const refreshTaskCount = useCallback(async () => {
    if (typeof window.api.countOpenTasks !== 'function') return
    setOpenTasks(await window.api.countOpenTasks())
  }, [])

  useEffect(() => {
    void refreshTaskCount()
  }, [refreshTaskCount, tasksOpen])
  const [signature, setSignature] = useState('')
  const [theme, setTheme] = useState<Theme>('system')

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      setSignature(s.signature ?? '')
      const t = isTheme(s.theme) ? s.theme : 'system'
      setTheme(t)
      applyTheme(t)
      setGroupByDate(s.list_group_by_date === '1')
    })
  }, [setGroupByDate])

  // "system" tracks the OS, so a change there must repaint without a restart.
  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  const onTheme = useCallback((t: Theme) => {
    setTheme(t)
    applyTheme(t)
    void window.api.setSettings({ theme: t })
  }, [])

  const onSignature = useCallback((html: string) => {
    setSignature(html)
    void window.api.setSettings({ signature: html })
  }, [])

  const [splits, setSplits] = useState<Split[]>([])
  const splitsRef = useRef<Split[]>([])
  const [splitCounts, setSplitCounts] = useState<Record<string, number>>({})
  const isInbox = useCallback(
    (fid: number | null) => useStore.getState().folders.find((f) => f.id === fid)?.role === 'inbox',
    []
  )
  const splitCountsRead = useRef(latestOnly(setSplitCounts))
  /**
   * Re-read the split tab counts. Every Inbox change goes through here, not
   * only a full list load: an optimistic remove or restore (Done, trash,
   * Remind me, undo) already keeps the pager total right, and the tabs must
   * agree with it. SQLite has the change by then, so the read is accurate.
   */
  const refreshSplitCounts = useCallback(
    async (folderId: number | null) => {
      if (folderId === null || !isInbox(folderId)) return
      await splitCountsRead.current(() =>
        window.api.splitCounts(folderId, viewQuery('', useStore.getState().chip))
      )
    },
    [isInbox]
  )

  /** What the list on screen shows: the split (Inbox only) ANDed with the chip. */
  const currentQuery = useCallback(
    (folderId: number): string => {
      const { splitId: sid, chip: c } = useStore.getState()
      const split = isInbox(folderId) ? splitsRef.current.find((s) => s.id === sid) : undefined
      return viewQuery(split?.query ?? '', c)
    },
    [isInbox]
  )

  const fetchPage = useCallback(
    async (folderId: number, page: number): Promise<MessageListRow[]> => {
      // Reminders is one local list, not an IMAP folder: no pages, no server.
      if (folderId === REMINDERS_VIEW_ID) return page === 0 ? window.api.listReminders() : []
      const offset = page * PAGE_SIZE
      return isDraftsFolder(folderId)
        ? window.api.listDrafts(PAGE_SIZE, offset)
        : window.api.listMessages(folderId, PAGE_SIZE, offset, currentQuery(folderId))
    },
    [isDraftsFolder, currentQuery]
  )

  const [streak, setStreak] = useState(0)
  /** Called when the plain Inbox (no split, no chip) loads empty. */
  const recordZero = useCallback(async () => {
    const s = await window.api.getSettings()
    const prev = { days: Number(s.zero_streak_days) || 0, lastDay: s.zero_last_day || null }
    const next = nextStreak(prev, dayKey(new Date()))
    setStreak(next.days)
    if (next.lastDay !== prev.lastDay)
      await window.api.setSettings({ zero_streak_days: String(next.days), zero_last_day: next.lastDay ?? '' })
  }, [])

  const loadRows = useCallback(
    async (folderId: number, keepPage = false) => {
      // A background sync refreshes in place; only an explicit folder switch
      // should send the user back to page 1.
      let page = keepPage ? useStore.getState().page : 0
      let rows = await fetchPage(folderId, page)
      const total =
        folderId === REMINDERS_VIEW_ID
          ? rows.length
          : await window.api.countMessages(folderId, currentQuery(folderId))
      // Emptying a later page (select all, Done) steps back to the last page
      // that still has mail, rather than showing an empty list over a full one.
      if (!rows.length && page > 0 && total > 0) {
        page = Math.min(page, Math.ceil(total / PAGE_SIZE) - 1)
        rows = await fetchPage(folderId, page)
      }
      // keepPage means a refresh under the user (sync, new mail): keep the
      // selection. Only a real folder or page change resets it.
      if (keepPage) setRows(rows)
      else setPageRows(rows)
      setPage(page)
      setTotalRows(total)
      await refreshSplitCounts(folderId)
      void refreshUnread()
      const st = useStore.getState()
      const plainInbox = isInbox(folderId) && st.splitId === 'all' && !st.chip
      if (isInboxZero({ plainInbox, total, hasSyncedOnce: st.hasSyncedOnce, syncError: st.syncError }))
        void recordZero()
    },
    [fetchPage, setRows, setPageRows, setPage, setTotalRows, refreshUnread, currentQuery, isInbox, recordZero, refreshSplitCounts]
  )

  const loadRowsRef = useRef(loadRows)
  loadRowsRef.current = loadRows

  /**
   * Repaint after an undo. Saved rows go back only into the view they came
   * from: after a folder, split, chip or account change they would land in the
   * wrong list (and duplicate rows it already holds), so that list is re-read.
   */
  const repaintAfterUndo = useCallback(
    (origin: ViewKey, removed: { index: number; row: MessageListRow }[]) => {
      const st = useStore.getState()
      if (removed.length && undoRepaint(origin, viewKey(st)) === 'restore') {
        restoreRows(removed)
        void refreshSplitCounts(st.activeFolderId)
      } else if (st.activeFolderId) void loadRows(st.activeFolderId, true)
    },
    [restoreRows, loadRows, refreshSplitCounts]
  )

  /**
   * Optimistic removal. When it empties the page, re-read: the next page's
   * mail moves up, and an empty plain Inbox records the zero streak (loadRows
   * owns that). SQLite already reflects the move, so the re-read is accurate.
   */
  const dropRows = useCallback(
    (ids: number[]) => {
      const removed = removeRows(ids)
      const st = useStore.getState()
      if (removed.length && !st.rows.length && st.activeFolderId) void loadRows(st.activeFolderId, true)
      else if (removed.length) void refreshSplitCounts(st.activeFolderId)
      return removed
    },
    [removeRows, loadRows, refreshSplitCounts]
  )

  // Reloaded when Settings closes, since custom splits are edited there. A
  // deleted active split falls back to All, and the list and the tab counts
  // are re-read so they match the new set of splits.
  useEffect(() => {
    if (settingsOpen) return
    void window.api.listSplits().then((s) => {
      splitsRef.current = s
      setSplits(s)
      const { splitId: sid, activeFolderId: fid } = useStore.getState()
      const next = resolveSplitId(s, sid)
      if (next !== sid) setSplit(next)
      if (fid) void loadRowsRef.current(fid, true)
    })
  }, [settingsOpen, setSplit])

  /**
   * Repaint the current page in place. A thread rollup cannot be patched from
   * one message's flags, so a thread-wide change has to re-read the page.
   */
  const refreshRows = useCallback(async () => {
    const { activeFolderId: f, page } = useStore.getState()
    if (!f) return
    // setRows, not setPageRows: the page has not changed, so the cursor and
    // any checked rows that still exist have to survive.
    setRows(await fetchPage(f, page))
  }, [fetchPage, setRows])

  /**
   * Jump to a page. When a page lands past what SQLite holds, reach further
   * back on the server first — the initial sync window is not the whole
   * mailbox, so running out locally does not mean running out of mail.
   */
  const goToPage = useCallback(
    async (next: number) => {
      const s = useStore.getState()
      const folderId = s.activeFolderId
      if (!folderId || s.loadingMore || next < 0) return
      setLoadingMore(true)
      try {
        let rows = await fetchPage(folderId, next)
        if (!rows.length && next > 0 && !isDraftsFolder(folderId) && folderId !== REMINDERS_VIEW_ID) {
          const older = await window.api.loadOlder(folderId, PAGE_SIZE)
          if (!older.ok) {
            setSyncError(older.error)
            return
          }
          if (!older.messages) return
          rows = await fetchPage(folderId, next)
          setTotalRows(await window.api.countMessages(folderId, currentQuery(folderId)))
        }
        if (!rows.length) return
        setPageRows(rows)
        setPage(next)
      } finally {
        setLoadingMore(false)
      }
    },
    [fetchPage, isDraftsFolder, setLoadingMore, setPageRows, setPage, setTotalRows, setSyncError, currentQuery]
  )

  const backgroundSync = useCallback(async () => {
    const before = useStore.getState()
    if (before.syncing || !before.email) return
    const res = await window.api.runSync()
    const after = useStore.getState()
    if (res.ok) {
      // Timer/focus overlapped an in-flight sync — not a failure.
      if (res.skipped) return
      setSyncError(null)
      // A folder added on the server (or by us) since boot only reaches the
      // sidebar and `g` jumps through the store.
      await reloadFolders()
      if (res.messages > 0 && after.activeFolderId)
        await loadRows(after.activeFolderId, true)
      else void refreshUnread()
    } else if (res.error !== 'sync already running') {
      setSyncError(res.error)
    }
  }, [loadRows, setSyncError, refreshUnread])

  useEffect(() => {
    const SYNC_INTERVAL = 60_000
    const FOCUS_COOLDOWN = 15_000
    let lastFocusSync = 0
    const timer = setInterval(() => void backgroundSync(), SYNC_INTERVAL)
    const onFocus = (): void => {
      const now = performance.now()
      if (now - lastFocusSync < FOCUS_COOLDOWN) return
      lastFocusSync = now
      void backgroundSync()
    }
    window.addEventListener('focus', onFocus)
    // IDLE push is the fast path; the timer stays as the fallback for when the
    // connection drops or the server never pushes.
    const offNewMail = window.api.onNewMail(() => void backgroundSync())
    // Sent gets no IDLE push (the watcher holds INBOX), so the main process
    // tells us when the just-sent copy has landed locally.
    const offSentStored = window.api.onSentStored(() => {
      const id = useStore.getState().activeFolderId
      if (id) void loadRows(id, true)
      else void refreshUnread()
    })
    // The repair rewrites thread ids under the current list, so reload rather
    // than leave rows pointing at conversations that just merged.
    const offRethread = window.api.onThreadingRepaired(() => {
      const id = useStore.getState().activeFolderId
      if (id) void loadRows(id, true)
    })
    // A reminder came due: its thread is back at the top of the Inbox if it has
    // an Inbox row, and the Reminders view shows it as fired.
    const offReminders = window.api.onRemindersFired(() => {
      const id = useStore.getState().activeFolderId
      if (id) void loadRows(id, true)
    })
    // The compose window is long gone by the time a send fails, so this banner
    // is the only thing standing between a failure and silence.
    const offSendFailed = window.api.onSendFailed((f) => {
      setActionError(
        `Send failed — “${f.subject || '(no subject)'}” to ${f.to}: ${f.error}`
      )
    })
    return () => {
      offReminders()
      offRethread()
      offSentStored()
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      offNewMail()
      offSendFailed()
    }
  }, [backgroundSync, loadRows, refreshUnread, setActionError])

  useEffect(() => {
    let cancelled = false

    const off = window.api.onSyncProgress((p) => {
      if (cancelled) return
      setSync(p.phase !== 'done' && p.phase !== 'error', p.folder ?? null)
    })

    let lastRefresh = 0
    const offBody = window.api.onBodySyncProgress((p) => {
      if (cancelled) return
      setSync(!p.done, p.done ? null : `bodies ${p.fetched}/${p.total}`)
      const now = performance.now()
      if (p.done || now - lastRefresh > 800) {
        lastRefresh = now
        const { activeFolderId: fid } = useStore.getState()
        if (fid) void loadRows(fid)
      }
    })

    ;(async () => {
      const status = await window.api.bootStatus()
      if (cancelled) return
      setBoot(status.email ?? null, status.ok ? null : (status.error ?? 'unknown error'))
      setAccounts(status.accounts ?? [])
      setActiveAccountId(status.activeAccountId ?? null)
      // A token that died while the app was closed fails before this window
      // subscribes to the reauth event, so boot status carries it too.
      const stale = status.accounts?.find((a) => a.needsReauth)
      if (stale) setReauthEmail(stale.email)
      if (!status.ok) return

      const cached = await window.api.listFolders()
      if (cancelled) return
      const inbox = cached.find((f) => f.role === 'inbox') ?? cached[0]
      if (cached.length) {
        setFolders(cached)
        if (inbox) {
          setActiveFolder(inbox.id)
          await loadRows(inbox.id)
        }
      }

      setSync(true)
      setSyncError(null)
      const syncRes = await window.api.runSync()
      if (cancelled) return
      setSync(false)
      setSyncedOnce()
      if (!syncRes.ok && syncRes.error !== 'sync already running') {
        setSyncError(syncRes.error)
      }

      const fresh = await window.api.listFolders()
      if (cancelled) return
      setFolders(fresh)
      // Keep whatever folder the user navigated to while the first sync ran —
      // jumping back to INBOX afterwards looks like the app forgot.
      const current = useStore.getState().activeFolderId
      const stillExists = Boolean(current && fresh.some((f) => f.id === current))
      const target = stillExists
        ? fresh.find((f) => f.id === current)!
        : (fresh.find((f) => f.role === 'inbox') ?? fresh[0])
      if (target) {
        if (!stillExists) setActiveFolder(target.id)
        await loadRows(target.id, stillExists)
      }

      void window.api.runBodySync()
    })()

    return () => {
      cancelled = true
      off()
      offBody()
    }
  }, [setBoot, setFolders, setActiveFolder, setSync, loadRows])

  const openThreadAndRead = useCallback(
    (threadId: string, messageId: number) => {
      openThreadView(threadId, messageId)
      void window.api.markThreadRead(threadId).then((res) => {
        if (res.ok) for (const id of res.changed) markRowSeen(id)
      })
    },
    [openThreadView, markRowSeen]
  )

  /** Reopen a draft in compose with its stored content. */
  const openDraft = useCallback(
    async (id: number) => {
      const msg = await window.api.getMessage(id)
      if (!msg) return
      // Restore every field, or reopening a draft silently sends without its
      // bcc, thread references, or attachments.
      let attachments: ComposeAttachment[] = []
      try {
        if (msg.draft_attachments) attachments = JSON.parse(msg.draft_attachments)
      } catch {
        attachments = []
      }
      openCompose({
        ...emptyCompose(),
        draftId: msg.folder_id == null ? msg.id : null,
        to: msg.to_addrs ?? '',
        cc: msg.cc_addrs ?? '',
        bcc: msg.bcc_addrs ?? '',
        subject: msg.subject ?? '',
        body: msg.body_html ?? msg.body_text ?? '',
        attachments,
        inReplyTo: msg.in_reply_to,
        references: msg.references_header
      })
    },
    [openCompose]
  )

  const openRow = useCallback(
    (index: number) => {
      const { rows: r, activeFolderId: fid } = useStore.getState()
      const row = r[index]
      if (!row) return
      if (fid && isDraftsFolder(fid)) {
        void openDraft(row.id)
        return
      }
      if (row.thread_id) openThreadAndRead(row.thread_id, row.id)
      const neighbors = [r[index + 1]?.id, r[index - 1]?.id].filter(
        (id): id is number => typeof id === 'number'
      )
      if (neighbors.length) void window.api.prefetchBodies(neighbors)
    },
    [openThreadAndRead, openDraft, isDraftsFolder]
  )

  const openSelected = useCallback(() => {
    openRow(useStore.getState().selectedIndex)
  }, [openRow])

  /** Checked rows, or the keyboard cursor row when nothing is checked. */
  const targetIds = useCallback((): number[] => {
    const { checkedIds: c, rows: r, selectedIndex: i } = useStore.getState()
    if (c.length) return c
    const row = r[i]
    return row ? [row.id] : []
  }, [])

  /** The open thread's message, or the checked rows / cursor row in the list. */
  const actionIds = useCallback((): number[] => {
    const ot = useStore.getState().openThread
    return ot ? [ot.messageId] : targetIds()
  }, [targetIds])

  /** Delete the focused/checked drafts straight from the list. */
  const deleteDrafts = useCallback(async (explicit?: number[]) => {
    const ids = explicit ?? targetIds()
    if (!ids.length) return
    for (const id of ids) await window.api.deleteDraft(id)
    dropRows(ids)
    clearChecked()
  }, [targetIds, dropRows, clearChecked])

  const applyFlags = useCallback(
    async (flag: string, add: boolean) => {
      const ids = targetIds()
      if (!ids.length) return
      if (typeof window.api.setFlag !== 'function') {
        setActionError('App needs restart — action APIs not loaded')
        return
      }
      try {
        const res = await window.api.setFlag(ids, flag, add)
        if (!res.ok) {
          setActionError(res.error)
          return
        }
        for (const u of res.updated) updateRowFlags(u.id, JSON.stringify(u.flags))
        void refreshUnread()
      } catch (e) {
        setActionError((e as Error).message)
      }
    },
    [targetIds, updateRowFlags, setActionError, refreshUnread]
  )

  const starSelected = useCallback(async () => {
    const { checkedIds: c, rows: r, selectedIndex: i } = useStore.getState()
    if (c.length) {
      // If any selected is unstarred, star all; else unstar all.
      const rowsById = new Map(r.map((row) => [row.id, row]))
      const anyUnstarred = c.some((id) => {
        const row = rowsById.get(id)
        if (!row?.flags) return true
        try {
          const flags: string[] = JSON.parse(row.flags)
          return !flags.some((f) => f.toLowerCase() === '\\flagged')
        } catch {
          return true
        }
      })
      await applyFlags('\\Flagged', anyUnstarred)
      return
    }
    const row = r[i]
    if (!row) return
    const res = await window.api.toggleFlag(row.id, '\\Flagged')
    if (res.ok) updateRowFlags(row.id, JSON.stringify(res.flags))
  }, [applyFlags, updateRowFlags])

  /** The checked rows, or the cursor row when nothing is checked. */
  const targetRows = useCallback((): MessageListRow[] => {
    const { checkedIds: c, rows: r, selectedIndex: i } = useStore.getState()
    return c.length ? r.filter((row) => c.includes(row.id)) : r[i] ? [r[i]] : []
  }, [])

  /**
   * Thread-scoped, because opening a row marks its whole thread read. Acting
   * on the newest message alone would be reverted by the next open.
   */
  const setThreadsRead = useCallback(
    async (read: boolean) => {
      const targets = targetRows()
      const threadIds = targets.map((row) => row.thread_id).filter((t): t is string => !!t)
      if (!threadIds.length) return
      if (read) {
        for (const threadId of threadIds) {
          const res = await window.api.markThreadRead(threadId)
          if (!res.ok) return setActionError(res.error)
          for (const id of res.changed) markRowSeen(id)
        }
      } else {
        const res = await window.api.markThreadsUnread(threadIds)
        if (!res.ok) return setActionError(res.error)
      }
      await refreshRows()
      void refreshUnread()
    },
    [targetRows, markRowSeen, refreshRows, refreshUnread, setActionError]
  )

  /** Linear-style: u toggles read ↔ unread on selection (or focused row). */
  const toggleReadSelected = useCallback(async () => {
    const targets = targetRows()
    if (!targets.length) return
    // Unread if any message anywhere in the thread is unread, matching the dot.
    const anyUnread = targets.some((row) =>
      row.thread_unread === undefined ? isUnread(row.flags) : row.thread_unread > 0
    )
    await setThreadsRead(anyUnread)
  }, [targetRows, setThreadsRead])

  const moveSelected = useCallback(
    /** `explicit` wins over the cursor/checked rows (thread mode passes the open thread's ids). */
    async (target: MoveTarget, verb: string, explicit?: number[]) => {
      const ids = explicit ?? targetIds()
      if (!ids.length) return
      if (typeof window.api.moveMessages !== 'function') {
        setActionError('App needs restart — action APIs not loaded')
        return
      }
      const origin = viewKey(useStore.getState())
      try {
        const res = await window.api.moveMessages(ids, target)
        if (!res.ok) {
          setActionError(res.error === 'no archive folder' ? NO_ARCHIVE : res.error)
          return
        }
        const removed = dropRows(res.moved)
        clearChecked()
        void refreshUnread()
        if (!res.batchId || !removed.length) return
        // Each batch commits on its own main-process timer, so replacing the
        // undo only drops the *offer* to undo the previous one, never the move.
        const n = removed.length
        pushUndo(`${verb} ${n} conversation${n === 1 ? '' : 's'}`, res.holdMs, async () => {
          const r = await window.api.undoMove(res.batchId)
          if (!r.ok) return setActionError(r.error)
          repaintAfterUndo(origin, removed)
          void refreshUnread()
        })
      } catch (e) {
        setActionError((e as Error).message)
      }
    },
    [targetIds, dropRows, repaintAfterUndo, clearChecked, setActionError, pushUndo, refreshUnread]
  )

  /** In Drafts there is nothing to MOVE — a local draft has no server uid. */
  const triageSelected = useCallback(
    async (ids?: number[]) => {
      const fid = useStore.getState().activeFolderId
      if (fid && isDraftsFolder(fid)) await deleteDrafts(ids)
      else await moveSelected({ role: 'trash' }, 'Trashed', ids)
    },
    [isDraftsFolder, deleteDrafts, moveSelected]
  )

  /**
   * Done in the Reminders view dismisses the reminder. Its row is the keyed
   * message, which for remind-on-send is the user's Sent copy: moving that to
   * Archive would file away Sent mail and leave the reminder pending.
   */
  const dismissReminders = useCallback(
    async (explicit?: number[]) => {
      const ids = explicit ?? targetIds()
      if (!ids.length) return
      const origin = viewKey(useStore.getState())
      const res = await window.api.clearReminders(ids)
      const removed = dropRows(ids)
      clearChecked()
      const n = res.cleared.length
      if (!n) return
      pushUndo(`Dismissed ${n} reminder${n === 1 ? '' : 's'}`, res.holdMs, async () => {
        await window.api.restoreReminders(res.cleared)
        repaintAfterUndo(origin, removed)
      })
    },
    [targetIds, dropRows, clearChecked, pushUndo, repaintAfterUndo]
  )

  const doneSelected = useCallback(
    (ids?: number[]) =>
      doneAction(useStore.getState().activeFolderId, REMINDERS_VIEW_ID) === 'dismissReminder'
        ? dismissReminders(ids)
        : moveSelected({ role: 'archive' }, 'Done', ids),
    [moveSelected, dismissReminders]
  )
  const notDoneSelected = useCallback(
    (ids?: number[]) => moveSelected({ role: 'inbox' }, 'Moved to Inbox', ids),
    [moveSelected]
  )
  const spamSelected = useCallback(
    (ids?: number[]) => moveSelected({ role: 'junk' }, 'Marked spam', ids),
    [moveSelected]
  )

  /**
   * Remind me is local. A pending reminder hides only the Inbox row, so only
   * the Inbox drops rows now; anywhere else (the Reminders view included) the
   * page is re-read. Undo puts a rescheduled reminder back as it was and
   * clears a fresh one.
   */
  const remindSelected = useCallback(
    async (at: number, ifNoReply: boolean, explicit?: number[]) => {
      const ids = explicit ?? targetIds()
      if (!ids.length) return
      const origin = viewKey(useStore.getState())
      const res = await window.api.setReminder(ids, at, ifNoReply)
      const inInbox = isInbox(useStore.getState().activeFolderId)
      const removed = inInbox ? dropRows(res.set) : []
      clearChecked()
      if (!inInbox) void refreshRows()
      const when = new Date(at).toLocaleString(undefined, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit'
      })
      pushUndo(`Reminder set for ${when}`, res.holdMs, async () => {
        if (res.prev.length) await window.api.restoreReminders(res.prev)
        if (res.fresh.length) await window.api.clearReminders(res.fresh)
        repaintAfterUndo(origin, removed)
      })
    },
    [targetIds, isInbox, dropRows, clearChecked, refreshRows, pushUndo, repaintAfterUndo]
  )

  /**
   * Thread-scoped triage. The list cursor may be anywhere, so these act on the
   * open thread's own message and then leave the thread — there is nothing
   * left to read once it is trashed.
   */
  /**
   * Triage from inside a thread, then open the next one.
   *
   * Auto-advance is the point: working an inbox down means acting and moving
   * on, not bouncing back to the list between every message. Falls back to the
   * list only at the end, where there is nothing left to advance to.
   */
  const triageFromThread = useCallback(
    async (act: (ids: number[]) => Promise<unknown>) => {
      const ot = useStore.getState().openThread
      if (!ot) return
      // Act on the open thread by id, never the cursor row: a sync can re-sort
      // the list under the reader so the cursor sits on another conversation.
      const { index: idx, ids } = openThreadTarget(useStore.getState().rows, ot)
      if (idx >= 0) setSelectedIndex(idx)
      clearChecked()
      closeThread()
      await act(ids)

      // The triaged row is gone, so the same index now holds the next message.
      // Reuse openRow so drafts and read-marking behave as they do elsewhere.
      const after = useStore.getState()
      const nextIndex = idx >= 0 ? Math.min(idx, after.rows.length - 1) : after.selectedIndex
      if (after.rows[nextIndex]) {
        setSelectedIndex(nextIndex)
        openRow(nextIndex)
      }
    },
    [setSelectedIndex, clearChecked, closeThread, openRow]
  )

  const starFromThread = useCallback(async () => {
    const ot = useStore.getState().openThread
    if (!ot) return
    const res = await window.api.toggleFlag(ot.messageId, '\\Flagged')
    if (res.ok) updateRowFlags(ot.messageId, JSON.stringify(res.flags))
  }, [updateRowFlags])

  const unreadFromThread = useCallback(async () => {
    const ot = useStore.getState().openThread
    if (!ot?.threadId) return
    // Opening the thread marked every message read, so this un-reads all of
    // them — clearing only the newest would leave the thread read.
    const res = await window.api.markThreadsUnread([ot.threadId])
    if (!res.ok) return setActionError(res.error)
    await refreshRows()
    void refreshUnread()
    closeThread()
  }, [setActionError, refreshRows, refreshUnread, closeThread])

  const onToggleCheck = useCallback(
    (id: number, index: number, shiftKey: boolean) => {
      if (shiftKey) checkRange(index)
      else toggleChecked(id, index)
    },
    [checkRange, toggleChecked]
  )

  const onFolder = useCallback(
    async (id: number) => {
      // Sidebar is global nav — leave thread/compose so the folder list shows.
      closeThread()
      closeCompose()
      clearChecked()
      setTasksOpen(false)
      setActiveFolder(id)
      await loadRows(id)
    },
    [closeThread, closeCompose, clearChecked, setActiveFolder, loadRows]
  )

  const reloadActive = useCallback(() => {
    const fid = useStore.getState().activeFolderId
    if (fid) void loadRows(fid)
  }, [loadRows])

  const cycleSplit = useCallback(
    (delta: number) => {
      if (!isInbox(useStore.getState().activeFolderId)) return
      const next = nextSplitId(splitsRef.current, useStore.getState().splitId, delta)
      if (!next) return
      setSplit(next)
      reloadActive()
    },
    [isInbox, setSplit, reloadActive]
  )

  const toggleChip = useCallback(
    (id: ChipId) => {
      setChip(useStore.getState().chip === id ? null : id)
      reloadActive()
    },
    [setChip, reloadActive]
  )

  const gotoFolder = useCallback(
    (role: FolderRole) => {
      const f = useStore.getState().folders.find((x) => x.role === role)
      if (f) void onFolder(f.id)
    },
    [onFolder]
  )

  /** Signature sits above any quoted text, which is where people expect it. */
  const withSignature = useCallback(
    (body: string): string => (signature ? `${body}<p><br></p>${signature}` : body),
    [signature]
  )

  const startCompose = useCallback(() => {
    openCompose({ ...emptyCompose(), body: withSignature('<p><br></p>') })
  }, [openCompose, withSignature])

  const startReply = useCallback(
    async (all: boolean) => {
      const { openThread: ot, email: me } = useStore.getState()
      if (!ot) return
      const msg = await window.api.getMessage(ot.messageId)
      if (!msg) return
      const to = msg.from_addr ?? ''
      let cc = ''
      if (all) {
        const addrs = new Set<string>()
        for (const part of [msg.to_addrs, msg.cc_addrs]) {
          if (!part) continue
          for (const a of part.split(/[,;]/)) {
            const t = a.trim()
            if (t && t.toLowerCase() !== me?.toLowerCase()) addrs.add(t)
          }
        }
        addrs.delete(to)
        cc = [...addrs].join(', ')
      }
      openCompose({
        ...emptyCompose(),
        mode: all ? 'replyAll' : 'reply',
        to,
        cc,
        subject: replySubject(msg.subject),
        inReplyTo: msg.message_id,
        references: [msg.in_reply_to, msg.message_id].filter(Boolean).join(' ') || null,
        body: signature
          ? `<p><br></p>${signature}${buildReplyBody(msg)}`
          : buildReplyBody(msg)
      })
    },
    [openCompose, signature]
  )

  const startForward = useCallback(async () => {
    const ot = useStore.getState().openThread
    if (!ot) return
    const msg = await window.api.getMessage(ot.messageId)
    if (!msg) return
    openCompose({
      ...emptyCompose(),
      mode: 'forward',
      subject: forwardSubject(msg.subject),
      // A forward starts a new conversation for the recipient, so it carries
      // no In-Reply-To/References — threading it into the original would be wrong.
      body: signature
        ? `<p><br></p>${signature}${buildForwardBody(msg)}`
        : buildForwardBody(msg)
    })
  }, [openCompose, signature])

  /**
   * Mute is local: the threads leave the Inbox (and the reader), and z unmutes.
   * Every target ends in one state; undo reverses only the threads that changed.
   */
  const muteSelected = useCallback(async () => {
    const ids = actionIds()
    if (!ids.length) return
    const origin = viewKey(useStore.getState())
    const res = await window.api.toggleMute(ids)
    if (!res.ok) return setActionError(res.error)
    if (useStore.getState().openThread) closeThread()
    clearChecked()
    // loadRows, not refreshRows: the total and the split counts change too.
    const fid = useStore.getState().activeFolderId
    if (fid) await loadRows(fid, true)
    const n = res.changed.length
    const label = `${res.muted ? 'Muted' : 'Unmuted'}${n > 1 ? ` ${n} conversations` : ''}`
    pushUndo(label, res.holdMs, async () => {
      await window.api.toggleMute(res.changed, !res.muted)
      repaintAfterUndo(origin, [])
    })
  }, [actionIds, setActionError, closeThread, clearChecked, loadRows, pushUndo, repaintAfterUndo])

  /** Gmail only: the account's user labels, checked where the targets already carry them. */
  const openLabelPicker = useCallback(async () => {
    const ids = actionIds()
    if (!ids.length) return
    const choices = await window.api.labelChoices()
    if (!choices.length) return setActionError('Labels are Gmail only')
    const current = new Set(Object.values(await window.api.labelsFor(ids)).flat())
    setOverlay({
      kind: 'label',
      ids,
      items: choices.map((c) => ({ id: c, label: c, checked: current.has(c) }))
    })
  }, [actionIds, setActionError])

  /** From a thread the reminder targets the open thread, then advances like Done. */
  const onRemindPick = useCallback(
    (at: number, ifNoReply: boolean) => {
      const o = overlay
      setOverlay(null)
      if (o?.kind === 'remind' && o.fromThread)
        void triageFromThread((ids) => remindSelected(at, ifNoReply, ids))
      else void remindSelected(at, ifNoReply)
    },
    [overlay, triageFromThread, remindSelected]
  )

  // Tasks counts as 'modal': it replaces the mail pane, and list keys (e, !,
  // ⌘A, Tab, …) would otherwise act on the hidden mail list.
  const surface = { compose: !!compose, tasksOpen, openThread: !!openThread }
  const mode: Mode = appMode({
    ...surface,
    overlayOpen: !!(paletteOpen || settingsOpen || shortcutsOpen || overlay)
  })
  // The palette's own mode is always 'modal'; its commands need the one under it.
  const paletteMode: Mode = baseMode(surface)

  const handlers = useMemo<Handlers>(
    () =>
      withTiming({
        // Checks compose itself, not the mode: a modal over compose (⌘, or ⌘.)
        // reads as 'modal', and ⌘K must still do nothing while composing.
        'palette.open': () => {
          if (!useStore.getState().compose) openPalette()
        },
        'compose.new': startCompose,
        'settings.open': () => setSettingsOpen(true),
        'shortcuts.open': () => setShortcutsOpen(true),
        escape: ({ mode: m }) => {
          if (m === 'thread') closeThread()
          else if (useStore.getState().checkedIds.length) clearChecked()
        },
        'sync.now': () => backgroundSync(),
        'account.add': () => setAddingAccount(true),
        'nav.down': () => moveSelection(1),
        'nav.up': () => moveSelection(-1),
        'nav.open': openSelected,
        'go.inbox': () => gotoFolder('inbox'),
        'go.sent': () => gotoFolder('sent'),
        'go.drafts': () => gotoFolder('drafts'),
        'go.trash': () => gotoFolder('trash'),
        'go.junk': () => gotoFolder('junk'),
        'go.done': () => {
          const acct = accounts.find((a) => a.accountId === activeAccountId)
          const t = goDoneTarget(useStore.getState().folders, acct?.provider)
          if ('folderId' in t) void onFolder(t.folderId)
          else setActionError(t.message)
        },
        'go.reminders': () => void onFolder(REMINDERS_VIEW_ID),
        'msg.star': ({ mode: m }) => (m === 'thread' ? starFromThread() : starSelected()),
        // In a thread, u un-reads and leaves, since staying would re-mark it read.
        'msg.read': ({ mode: m }) => (m === 'thread' ? unreadFromThread() : toggleReadSelected()),
        'msg.trash': ({ mode: m }) => (m === 'thread' ? triageFromThread(triageSelected) : triageSelected()),
        'msg.done': ({ mode: m }) => (m === 'thread' ? triageFromThread(doneSelected) : doneSelected()),
        'msg.notDone': ({ mode: m }) =>
          m === 'thread' ? triageFromThread(notDoneSelected) : notDoneSelected(),
        'msg.spam': ({ mode: m }) => (m === 'thread' ? triageFromThread(spamSelected) : spamSelected()),
        // In the Reminders view every row already has one, so the picker offers to remove it.
        'msg.remind': ({ mode: m }) =>
          setOverlay({
            kind: 'remind',
            fromThread: m === 'thread',
            hasReminder: useStore.getState().activeFolderId === REMINDERS_VIEW_ID
          }),
        'msg.move': ({ mode: m }) => setOverlay({ kind: 'move', fromThread: m === 'thread' }),
        'msg.label': () => openLabelPicker(),
        'msg.mute': () => muteSelected(),
        'msg.vip': async () => {
          const ids = actionIds()
          if (!ids.length) return
          const origin = viewKey(useStore.getState())
          const r = await window.api.toggleVip(ids)
          if (!r.ok) return setActionError(r.error)
          clearChecked()
          // The VIP and Important splits read vip_senders at query time.
          const fid = useStore.getState().activeFolderId
          if (fid) await loadRows(fid, true)
          // A blind toggle: the toast says which way it went.
          const n = r.changed.length
          const who = n > 1 ? ` ${n} senders` : ''
          pushUndo(r.vip ? `Marked${who} VIP` : `Removed${who} from VIP`, r.holdMs, async () => {
            await window.api.toggleVip(r.changed, !r.vip)
            repaintAfterUndo(origin, [])
          })
        },
        'msg.unsubscribe': async () => {
          const [id] = actionIds()
          if (!id) return
          const p = await window.api.unsubscribePlan(id)
          if (!p.ok) return setActionError(p.error)
          setOverlay({ kind: 'unsubscribe', id, sender: p.sender, description: p.description })
        },
        'triage.zero': () => {
          const fid = useStore.getState().activeFolderId
          if (fid && isInbox(fid)) setOverlay({ kind: 'zero', folderId: fid })
          else setActionError('Get me to zero works on the Inbox')
        },
        'msg.select': () => {
          const { rows: r, selectedIndex: i } = useStore.getState()
          const row = r[i]
          if (row) toggleChecked(row.id, i)
        },
        'thread.reply': () => startReply(false),
        'thread.replyAll': () => startReply(true),
        'thread.forward': () => startForward(),
        undo: () => runUndo(),
        'split.next': () => cycleSplit(1),
        'split.prev': () => cycleSplit(-1),
        'filter.unread': () => toggleChip('unread'),
        'filter.needsReply': () => toggleChip('needsReply'),
        'filter.waiting': () => toggleChip('waiting'),
        'filter.starred': () => toggleChip('starred'),
        'list.groupByDate': () => {
          const on = !useStore.getState().groupByDate
          setGroupByDate(on)
          void window.api.setSettings({ list_group_by_date: on ? '1' : '0' })
        },
        'select.all': () => setCheckedAll(useStore.getState().rows.map((r) => r.id)),
        'select.extendDown': () => extendSelection(1),
        'select.extendUp': () => extendSelection(-1)
      }),
    [
      openPalette,
      startCompose,
      closeThread,
      clearChecked,
      backgroundSync,
      moveSelection,
      openSelected,
      gotoFolder,
      starFromThread,
      starSelected,
      unreadFromThread,
      toggleReadSelected,
      triageFromThread,
      triageSelected,
      doneSelected,
      notDoneSelected,
      spamSelected,
      openLabelPicker,
      muteSelected,
      actionIds,
      setActionError,
      loadRows,
      pushUndo,
      onFolder,
      toggleChecked,
      startReply,
      startForward,
      runUndo,
      cycleSplit,
      toggleChip,
      setGroupByDate,
      setCheckedAll,
      extendSelection,
      isInbox,
      accounts,
      activeAccountId,
      repaintAfterUndo
    ]
  )

  const bindings = useMemo(() => buildBindings(mode, handlers), [mode, handlers])
  useHotkeys(mode, bindings)
  const chords = useMemo(() => buildChords(mode, handlers), [mode, handlers])
  useCommandChord(chords)
  const sequences = useMemo(() => buildSequences(mode, handlers), [mode, handlers])
  useKeySequences(sequences)

  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      ...buildPaletteActions(paletteMode, handlers),
      {
        id: 'scheduled',
        label: scheduled.length
          ? `Scheduled sends (${scheduled.length})`
          : 'Show scheduled sends',
        run: async () => setScheduled(await window.api.listScheduled())
      },
      // Each pending send is its own action, so cancelling is a normal palette
      // pick rather than a blocking confirm() the app cannot style or dismiss.
      ...scheduled.map((r) => ({
        id: `cancel-${r.id}`,
        label: `Cancel: ${r.subject || '(no subject)'} → ${r.to_addrs}`,
        hint: new Date(r.send_at).toLocaleString(),
        run: async () => {
          await window.api.cancelSend(r.id)
          setScheduled(await window.api.listScheduled())
        }
      }))
    ],
    [paletteMode, handlers, scheduled]
  )

  const onSent = useCallback(
    (outboxId: number, subject: string, undoMs: number, immediate: boolean) => {
      // A scheduled send is cancelled from ⌘K, not undone.
      if (!immediate) return
      pushUndo(`Sending “${subject}”`, undoMs, async () => {
        await window.api.cancelSend(outboxId)
      })
    },
    [pushUndo]
  )

  // No account is the normal first-run state; anything else is a real fault
  // and still deserves the raw message.
  if (bootError === NO_ACCOUNT) {
    return (
      <>
        <div className="titlebar-drag" />
        <Onboarding onConnected={() => window.location.reload()} />
      </>
    )
  }

  if (bootError) {
    return (
      <div className="app" style={{ gridTemplateColumns: '1fr' }}>
        <div className="titlebar-drag" />
        <div className="error-view">
          <h2>Setup needed</h2>
          <pre>{bootError}</pre>
        </div>
      </div>
    )
  }

  const active = folders.find((f) => f.id === activeFolderId)
  // Thread actions target the open thread's row, not wherever the list cursor
  // happens to be — those drift apart once you scroll the list underneath.
  const openRowFlags = openThread
    ? (rows.find((r) => r.id === openThread.messageId)?.flags ?? null)
    : null
  const openStarred = isFlagged(openRowFlags)

  return (
    <div className="app">
      <div className="titlebar-drag" />
      <Sidebar
        email={email}
        accounts={accounts}
        activeAccountId={activeAccountId}
        onSwitchAccount={switchAccount}
        onAddAccount={() => setAddingAccount(true)}
        folders={folders}
        activeFolderId={activeFolderId}
        onSelect={(id) => {
          setTasksOpen(false)
          onFolder(id)
        }}
        onSettings={() => setSettingsOpen(true)}
        onShortcuts={() => setShortcutsOpen(true)}
        onTasks={() => setTasksOpen((v) => !v)}
        tasksActive={tasksOpen}
        openTasks={openTasks}
        unread={unread}
      />
      <main className="main">
        {reauthEmail && (
          <div className="reauth-banner" role="alert">
            <span>{reauthEmail} needs you to sign in again.</span>
            <button onClick={() => void reauth()} disabled={reauthBusy}>
              {reauthBusy ? 'Waiting for browser…' : 'Sign in'}
            </button>
            <button
              className="reauth-dismiss"
              onClick={() => setReauthEmail(null)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        {compose ? (
          <Compose compose={compose} onClose={closeCompose} onSent={onSent} />
        ) : tasksOpen ? (
          <>
            <header className="list-header">
              <h1 className="list-title">Tasks</h1>
              <span className="list-meta">{openTasks}</span>
              <button
                className="header-compose"
                title="New task"
                onClick={(e) => {
                  e.currentTarget.blur()
                  setCreatingTask(true)
                }}
              >
                <Plus size={12} strokeWidth={2.5} />
                Add task
              </button>
            </header>
            <Tasks
              onChange={refreshTaskCount}
              creating={creatingTask}
              onCloseCreate={() => setCreatingTask(false)}
            />
          </>
        ) : openThread ? (
          <Thread
            threadId={openThread.threadId}
            focusMessageId={openThread.messageId}
            onBack={closeThread}
            onReply={(all) => void startReply(all)}
            onForward={() => void startForward()}
            onTrash={() => void triageFromThread(triageSelected)}
            onDone={() => void triageFromThread(doneSelected)}
            onStar={() => void starFromThread()}
            onToggleRead={() => void unreadFromThread()}
            starred={openStarred}
          />
        ) : (
          <>
            <header className="list-header">
              <h1 className="list-title">
                {activeFolderId === REMINDERS_VIEW_ID
                  ? 'Reminders'
                  : active
                    ? folderLabel(active)
                    : 'Supermail'}
              </h1>
              <span className="list-meta">
                {rows.length}
                {/* Quiet by design: a spinner, not a moving line. Detail on hover. */}
                {syncing && (
                  <span
                    className="sync-dot"
                    role="status"
                    aria-label="Syncing"
                    title={syncLabel ?? 'Syncing…'}
                  />
                )}
              </span>
              <button
                className="header-compose"
                title="Compose (c)"
                onClick={(e) => {
                  // Keep focus on the document so j/k still work after clicking.
                  e.currentTarget.blur()
                  startCompose()
                }}
              >
                <PenSquare size={12} strokeWidth={2} />
                Compose
              </button>
            </header>
            {syncError && (
              <div className="sync-error-banner" role="alert">
                <span>Sync failed: {syncError}</span>
                <button onClick={() => setSyncError(null)} aria-label="Dismiss">
                  ✕
                </button>
              </div>
            )}
            {actionError && (
              <div className="sync-error-banner" role="alert">
                <span>{actionError}</span>
                <button onClick={() => setActionError(null)} aria-label="Dismiss">
                  ✕
                </button>
              </div>
            )}
            {active && active.role !== 'drafts' && (
              <SplitBar
                splits={active.role === 'inbox' ? splits : null}
                counts={splitCounts}
                activeSplit={splitId}
                chip={chip}
                onSplit={(id) => {
                  setSplit(id)
                  reloadActive()
                }}
                onChip={toggleChip}
              />
            )}
            {rows.length > 0 && (
              <ActionBar
                count={checkedIds.length}
                allSelected={checkedIds.length > 0 && checkedIds.length === rows.length}
                onToggleAll={() => {
                  if (checkedIds.length === rows.length) clearChecked()
                  else setCheckedAll(rows.map((r) => r.id))
                }}
                onClear={clearChecked}
                onMarkRead={() => void setThreadsRead(true)}
                onMarkUnread={() => void setThreadsRead(false)}
                onStar={() => void starSelected()}
                onDone={() => void doneSelected()}
                onTrash={() => void moveSelected({ role: 'trash' }, 'Trashed')}
              />
            )}
            {rows.length === 0 && !hasSyncedOnce ? (
              <div className="list-scroll">
                <div className="empty">
                  <span className="empty-title">Syncing your mail…</span>
                  <span className="empty-sub">Fetching from {email}</span>
                </div>
              </div>
            ) : (
              /* Rendered even when empty: swapping it out for an empty-state
                 div would unmount the pager and make it flash on every page. */
              <MessageList
                showRecipient={showRecipient}
                emptyTitle={syncError ? 'Could not load mail' : 'No messages'}
                emptySub={
                  syncError
                    ? 'Check your connection and try again.'
                    : chip || (active?.role === 'inbox' && splitId !== 'all')
                      ? 'Nothing matches this view'
                      : active
                        ? `${folderLabel(active)} is empty`
                        : ''
                }
                emptyNode={
                  isInboxZero({
                    plainInbox: active?.role === 'inbox' && splitId === 'all' && !chip,
                    total: totalRows,
                    hasSyncedOnce,
                    syncError
                  }) ? (
                    <ZeroState streak={streak} />
                  ) : undefined
                }
                // Reminders sorts by due time, not received date, so date
                // headers there would be out of order.
                groupByDate={groupByDate && activeFolderId !== REMINDERS_VIEW_ID}
                rows={rows}
                selectedIndex={selectedIndex}
                checkedIds={checkedIds}
                onSelect={setSelectedIndex}
                onToggleCheck={onToggleCheck}
                onOpen={openRow}
                page={page}
                pageSize={PAGE_SIZE}
                totalRows={totalRows}
                loadingMore={loadingMore}
                onPage={(n) => void goToPage(n)}
              />
            )}
          </>
        )}
      </main>
      <CommandPalette
        open={paletteOpen}
        actions={paletteActions}
        onClose={closePalette}
        onOpenMessage={openThreadAndRead}
      />
      {settingsOpen && (
        <Settings
          email={email}
          signature={signature}
          theme={theme}
          onSignature={onSignature}
          onTheme={onTheme}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {shortcutsOpen && <ShortcutHelp onClose={() => setShortcutsOpen(false)} />}
      {overlay?.kind === 'remind' && (
        <RemindPicker
          onPick={onRemindPick}
          onClose={() => setOverlay(null)}
          onClear={
            overlay.hasReminder
              ? async () => {
                  setOverlay(null)
                  await window.api.clearReminders(targetIds())
                  void refreshRows()
                }
              : undefined
          }
        />
      )}
      {overlay?.kind === 'move' && (
        <Picker
          title="Move to"
          items={folders
            .filter((f) => f.id !== activeFolderId && f.role !== 'drafts')
            .map((f) => ({ id: String(f.id), label: folderLabel(f) }))}
          onClose={() => setOverlay(null)}
          onPick={(id) => {
            const fromThread = overlay.fromThread
            setOverlay(null)
            // From a thread, move the open thread's own ids, never the cursor row.
            const move = (ids?: number[]) => moveSelected({ folderId: Number(id) }, 'Moved', ids)
            void (fromThread ? triageFromThread(move) : move())
          }}
        />
      )}
      {overlay?.kind === 'label' && (
        <Picker
          title="Label"
          items={overlay.items}
          onClose={() => setOverlay(null)}
          onPick={async (label) => {
            const item = overlay.items.find((i) => i.id === label)
            const add = !item?.checked
            const r = await window.api.setLabel(overlay.ids, label, add)
            if (!r.ok) return setActionError(r.error)
            setOverlay({
              ...overlay,
              items: overlay.items.map((i) => (i.id === label ? { ...i, checked: add } : i))
            })
          }}
        />
      )}
      {overlay?.kind === 'unsubscribe' && (
        <ConfirmDialog
          title={`Unsubscribe from ${overlay.sender}?`}
          body={overlay.description}
          confirmLabel="Unsubscribe"
          onCancel={() => setOverlay(null)}
          onConfirm={async () => {
            const id = overlay.id
            setOverlay(null)
            const r = await window.api.unsubscribe(id)
            if (!r.ok) setActionError(r.error)
          }}
        />
      )}
      {overlay?.kind === 'zero' && (
        <ZeroModal
          folderId={overlay.folderId}
          onCancel={() => setOverlay(null)}
          onDone={async (opts) => {
            const fid = overlay.folderId
            setOverlay(null)
            const origin = viewKey(useStore.getState())
            const r = await window.api.zero(fid, opts)
            if (!r.ok) return setActionError(r.error === 'no archive folder' ? NO_ARCHIVE : r.error)
            await loadRows(fid)
            const n = r.moved.length
            pushUndo(`Done ${n} message${n === 1 ? '' : 's'}`, r.holdMs, async () => {
              const u = await window.api.undoMove(r.batchId)
              if (!u.ok) return setActionError(u.error)
              repaintAfterUndo(origin, [])
            })
          }}
        />
      )}
      {addingAccount && (
        <div className="onboard-overlay">
          <Onboarding
            mode="add"
            onCancel={() => setAddingAccount(false)}
            onConnected={() => window.location.reload()}
          />
        </div>
      )}
      {undo && (
        <UndoToast
          expiresAt={undo.expiresAt}
          label={undo.label}
          onUndo={() => void runUndo()}
          onDismiss={() => setUndo(null)}
        />
      )}
    </div>
  )
}
