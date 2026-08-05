import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ScheduledSend } from '../../electron/preload'
import type { MessageListRow } from '../core/store/types'
import { emptyCompose, useStore, type ComposeAttachment } from './store'
import { useHotkeys, type Binding, type Mode } from './hooks/useHotkeys'
import { useCommandChord } from './hooks/useCommandChord'
import { MessageList } from './views/MessageList'
import { ActionBar } from './views/ActionBar'
import { Sidebar } from './views/Sidebar'
import { Thread } from './views/Thread'
import { CommandPalette, type PaletteAction } from './views/CommandPalette'
import { Compose } from './views/Compose'
import { UndoToast } from './views/UndoToast'
import { Settings } from './views/Settings'
import { folderLabel, isFlagged, isUnread } from './format'
import { buildForwardBody, buildReplyBody } from './quote'
import { applyTheme, isTheme, type Theme } from './theme'
import './styles/app.css'

const PAGE_SIZE = 50
/** Must not exceed main's UNDO_MOVE_MS, or the toast outlives the undo. */
const UNDO_MOVE_MS = 3_000

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
    setSyncedOnce,
    hasSyncedOnce,
    paletteOpen,
    openPalette,
    closePalette,
    compose,
    openCompose,
    closeCompose,
    undoToast,
    setUndoToast,
    moveToast,
    setMoveToast,
    unread,
    setUnread,
    loadingMore,
    setLoadingMore,
    page,
    setPage,
    totalRows,
    setTotalRows
  } = useStore()

  // Expanded inline in the palette; reset on close so it never shows stale rows.
  const [scheduled, setScheduled] = useState<ScheduledSend[]>([])
  useEffect(() => {
    if (!paletteOpen) setScheduled([])
  }, [paletteOpen])

  const refreshUnread = useCallback(async () => {
    setUnread(await window.api.unreadCounts())
  }, [setUnread])

  /** Drafts live outside any folder, so that view has its own query. */
  const isDraftsFolder = useCallback((folderId: number): boolean => {
    const f = useStore.getState().folders.find((x) => x.id === folderId)
    return f?.path === 'Drafts'
  }, [])

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [signature, setSignature] = useState('')
  const [theme, setTheme] = useState<Theme>('system')

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      setSignature(s.signature ?? '')
      const t = isTheme(s.theme) ? s.theme : 'system'
      setTheme(t)
      applyTheme(t)
    })
  }, [])

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

  const fetchPage = useCallback(
    async (folderId: number, page: number): Promise<MessageListRow[]> => {
      const offset = page * PAGE_SIZE
      return isDraftsFolder(folderId)
        ? window.api.listDrafts(PAGE_SIZE, offset)
        : window.api.listMessages(folderId, PAGE_SIZE, offset)
    },
    [isDraftsFolder]
  )

  const loadRows = useCallback(
    async (folderId: number, keepPage = false) => {
      // A background sync refreshes in place; only an explicit folder switch
      // should send the user back to page 1.
      const page = keepPage ? useStore.getState().page : 0
      const rows = await fetchPage(folderId, page)
      setPageRows(rows)
      setPage(page)
      setTotalRows(await window.api.countMessages(folderId))
      void refreshUnread()
    },
    [fetchPage, setPageRows, setPage, setTotalRows, refreshUnread]
  )

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
        if (!rows.length && next > 0 && !isDraftsFolder(folderId)) {
          const older = await window.api.loadOlder(folderId, PAGE_SIZE)
          if (!older.ok) {
            setSyncError(older.error)
            return
          }
          if (!older.messages) return
          rows = await fetchPage(folderId, next)
          setTotalRows(await window.api.countMessages(folderId))
        }
        if (!rows.length) return
        setPageRows(rows)
        setPage(next)
      } finally {
        setLoadingMore(false)
      }
    },
    [fetchPage, isDraftsFolder, setLoadingMore, setPageRows, setPage, setTotalRows, setSyncError]
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
    // The compose window is long gone by the time a send fails, so this banner
    // is the only thing standing between a failure and silence.
    const offSendFailed = window.api.onSendFailed((f) => {
      setSyncError(
        `Send failed — “${f.subject || '(no subject)'}” to ${f.to}: ${f.error}`
      )
    })
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      offNewMail()
      offSendFailed()
    }
  }, [backgroundSync, setSyncError])

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
      if (!status.ok) return

      const cached = await window.api.listFolders()
      if (cancelled) return
      const inbox = cached.find((f) => f.path === 'INBOX') ?? cached[0]
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
        : (fresh.find((f) => f.path === 'INBOX') ?? fresh[0])
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

  /** Delete the focused/checked drafts straight from the list. */
  const deleteDrafts = useCallback(async () => {
    const ids = targetIds()
    if (!ids.length) return
    for (const id of ids) await window.api.deleteDraft(id)
    removeRows(ids)
    clearChecked()
  }, [targetIds, removeRows, clearChecked])

  const applyFlags = useCallback(
    async (flag: string, add: boolean) => {
      const ids = targetIds()
      if (!ids.length) return
      if (typeof window.api.setFlag !== 'function') {
        setSyncError('App needs restart — action APIs not loaded')
        return
      }
      try {
        const res = await window.api.setFlag(ids, flag, add)
        if (!res.ok) {
          setSyncError(res.error)
          return
        }
        for (const u of res.updated) updateRowFlags(u.id, JSON.stringify(u.flags))
        void refreshUnread()
      } catch (e) {
        setSyncError((e as Error).message)
      }
    },
    [targetIds, updateRowFlags, setSyncError, refreshUnread]
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

  /** Linear-style: u toggles read ↔ unread on selection (or focused row). */
  const toggleReadSelected = useCallback(async () => {
    const { checkedIds: c, rows: r, selectedIndex: i } = useStore.getState()
    const targets = c.length ? c : r[i] ? [r[i].id] : []
    if (!targets.length) return
    const rowsById = new Map(r.map((row) => [row.id, row]))
    // If any target is unread, mark all read; otherwise mark all unread.
    const anyUnread = targets.some((id) => isUnread(rowsById.get(id)?.flags ?? null))
    await applyFlags('\\Seen', anyUnread)
  }, [applyFlags])

  const moveSelected = useCallback(
    async () => {
      const ids = targetIds()
      if (!ids.length) return
      if (typeof window.api.moveMessages !== 'function') {
        setSyncError('App needs restart — action APIs not loaded')
        return
      }
      try {
        const res = await window.api.moveMessages(ids)
        if (!res.ok) {
          setSyncError(res.error)
          return
        }
        const removed = removeRows(res.moved)
        clearChecked()
        void refreshUnread()
        if (!res.batchId || !removed.length) return
        // Each batch commits on its own main-process timer, so replacing the
        // toast only drops the *offer* to undo the previous one, never the move.
        const n = removed.length
        setMoveToast({
          batchId: res.batchId,
          label: `Trashed ${n} message${n === 1 ? '' : 's'}`,
          expiresAt: Date.now() + UNDO_MOVE_MS,
          removed
        })
      } catch (e) {
        setSyncError((e as Error).message)
      }
    },
    [targetIds, removeRows, clearChecked, setSyncError, setMoveToast, refreshUnread]
  )

  const onUndoMove = useCallback(async () => {
    const toast = useStore.getState().moveToast
    if (!toast) return
    setMoveToast(null)
    const res = await window.api.undoMove(toast.batchId)
    if (!res.ok) {
      setSyncError(res.error)
      return
    }
    restoreRows(toast.removed)
    void refreshUnread()
  }, [setMoveToast, restoreRows, setSyncError, refreshUnread])

  /** In Drafts there is nothing to MOVE — a local draft has no server uid. */
  const triageSelected = useCallback(
    async () => {
      const fid = useStore.getState().activeFolderId
      if (fid && isDraftsFolder(fid)) await deleteDrafts()
      else await moveSelected()
    },
    [isDraftsFolder, deleteDrafts, moveSelected]
  )

  /**
   * Thread-scoped triage. The list cursor may be anywhere, so these act on the
   * open thread's own message and then leave the thread — there is nothing
   * left to read once it is trashed.
   */
  const triageFromThread = useCallback(
    async () => {
      const ot = useStore.getState().openThread
      if (!ot) return
      const idx = useStore.getState().rows.findIndex((r) => r.id === ot.messageId)
      if (idx >= 0) setSelectedIndex(idx)
      clearChecked()
      closeThread()
      await triageSelected()
    },
    [setSelectedIndex, clearChecked, closeThread, triageSelected]
  )

  const starFromThread = useCallback(async () => {
    const ot = useStore.getState().openThread
    if (!ot) return
    const res = await window.api.toggleFlag(ot.messageId, '\\Flagged')
    if (res.ok) updateRowFlags(ot.messageId, JSON.stringify(res.flags))
  }, [updateRowFlags])

  const unreadFromThread = useCallback(async () => {
    const ot = useStore.getState().openThread
    if (!ot) return
    // Opening the thread marked it read, so this always means "back to unread".
    const res = await window.api.setFlag([ot.messageId], '\\Seen', false)
    if (!res.ok) return setSyncError(res.error)
    for (const u of res.updated) updateRowFlags(u.id, JSON.stringify(u.flags))
    void refreshUnread()
    closeThread()
  }, [updateRowFlags, setSyncError, refreshUnread, closeThread])

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
      setActiveFolder(id)
      await loadRows(id)
    },
    [closeThread, closeCompose, clearChecked, setActiveFolder, loadRows]
  )

  const gotoFolder = useCallback(
    (path: string) => {
      const f = useStore.getState().folders.find((x) => x.path === path)
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

  useEffect(() => {
    if (openThread || paletteOpen || compose) return
    const GOTO: Record<string, string> = {
      i: 'INBOX',
      s: 'Sent Messages',
      t: 'Deleted Messages',
      d: 'Drafts',
      j: 'Junk'
    }
    let armed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const disarm = (): void => {
      armed = false
      if (timer) clearTimeout(timer)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return

      if (armed) {
        const path = GOTO[e.key]
        disarm()
        if (path) {
          e.preventDefault()
          gotoFolder(path)
        }
        return
      }
      if (e.key === 'g') {
        armed = true
        timer = setTimeout(disarm, 1200)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      disarm()
    }
  }, [openThread, paletteOpen, compose, gotoFolder])

  const mode: Mode = paletteOpen || settingsOpen
    ? 'modal'
    : compose
      ? 'compose'
      : openThread
        ? 'thread'
        : 'list'

  const bindings = useMemo<Binding[]>(
    () => [
      { key: 'j', modes: ['list'], handler: () => moveSelection(1) },
      { key: 'k', modes: ['list'], handler: () => moveSelection(-1) },
      { key: 'Enter', modes: ['list'], handler: openSelected },
      { key: 's', modes: ['list'], handler: () => void starSelected() },
      {
        key: 'x',
        modes: ['list'],
        handler: () => {
          const { rows: r, selectedIndex: i } = useStore.getState()
          const row = r[i]
          if (row) toggleChecked(row.id, i)
        }
      },
      {
        key: 'u',
        modes: ['list'],
        handler: () => void toggleReadSelected()
      },
      // The Mac key labelled "delete" reports as Backspace.
      { key: 'Backspace', modes: ['list'], handler: () => void triageSelected() },
      // Matches the list: u is unread. It closes the thread too, since leaving
      // it open would immediately re-mark it read.
      { key: 'u', modes: ['thread'], handler: () => void unreadFromThread() },
      {
        key: 'Escape',
        modes: ['list'],
        handler: () => {
          if (useStore.getState().checkedIds.length) clearChecked()
        }
      },
      { key: 'Escape', modes: ['thread'], handler: closeThread },
      { key: '/', modes: ['list', 'thread'], handler: () => openPalette() },
      { key: 'c', modes: ['list', 'thread'], handler: startCompose },
      { key: 'r', modes: ['thread'], handler: () => void startReply(false) },
      { key: 'R', modes: ['thread'], handler: () => void startReply(true) },
      { key: 'f', modes: ['thread'], handler: () => void startForward() },
      { key: 'Backspace', modes: ['thread'], handler: () => void triageFromThread() },
      { key: 's', modes: ['thread'], handler: () => void starFromThread() },
      { key: ',', modes: ['list', 'thread'], handler: () => setSettingsOpen(true) }
    ],
    [
      moveSelection,
      openSelected,
      starSelected,
      toggleReadSelected,
      toggleChecked,
      applyFlags,
      triageSelected,
      clearChecked,
      closeThread,
      openPalette,
      startCompose,
      startReply,
      startForward,
      triageFromThread,
      starFromThread,
      unreadFromThread
    ]
  )

  useHotkeys(mode, bindings)

  const chords = useMemo(
    () => [
      {
        key: 'k',
        handler: () => {
          if (compose) return
          openPalette()
        }
      }
    ],
    [compose, openPalette]
  )
  useCommandChord(chords)

  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      { id: 'compose', label: 'Compose new message', hint: 'c', run: startCompose },
      {
        id: 'inbox',
        label: 'Go to Inbox',
        hint: 'g i',
        run: () => gotoFolder('INBOX')
      },
      {
        id: 'sent',
        label: 'Go to Sent',
        hint: 'g s',
        run: () => gotoFolder('Sent Messages')
      },
      {
        id: 'trash',
        label: 'Go to Trash',
        hint: 'g t',
        run: () => gotoFolder('Deleted Messages')
      },
      {
        id: 'drafts',
        label: 'Go to Drafts',
        hint: 'g d',
        run: () => gotoFolder('Drafts')
      },
      {
        id: 'sync',
        label: 'Sync now',
        run: () => void backgroundSync()
      },
      {
        id: 'settings',
        label: 'Settings',
        hint: ',',
        run: () => setSettingsOpen(true)
      },
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
    [startCompose, gotoFolder, backgroundSync, scheduled]
  )

  const onSent = useCallback(
    (outboxId: number, subject: string, undoMs: number) => {
      // Only an immediate send gets a toast; a scheduled send is not undoable here.
      if (undoMs > 0 && undoMs <= 5_000) {
        setUndoToast({ outboxId, subject, expiresAt: Date.now() + undoMs })
      }
    },
    [setUndoToast]
  )

  const onUndo = useCallback(
    async (outboxId: number) => {
      await window.api.cancelSend(outboxId)
      setUndoToast(null)
    },
    [setUndoToast]
  )

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
        folders={folders}
        activeFolderId={activeFolderId}
        onSelect={onFolder}
        onSettings={() => setSettingsOpen(true)}
        unread={unread}
      />
      <main className="main">
        {compose ? (
          <Compose compose={compose} onClose={closeCompose} onSent={onSent} />
        ) : openThread ? (
          <Thread
            threadId={openThread.threadId}
            focusMessageId={openThread.messageId}
            onBack={closeThread}
            onReply={(all) => void startReply(all)}
            onForward={() => void startForward()}
            onTrash={() => void triageFromThread()}
            onStar={() => void starFromThread()}
            onToggleRead={() => void unreadFromThread()}
            starred={openStarred}
          />
        ) : (
          <>
            <header className="list-header">
              <h1 className="list-title">
                {active ? folderLabel(active.path, active.name) : 'Supermail'}
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
            </header>
            {syncError && (
              <div className="sync-error-banner" role="alert">
                <span>Sync failed: {syncError}</span>
                <button onClick={() => setSyncError(null)} aria-label="Dismiss">
                  ✕
                </button>
              </div>
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
                onMarkRead={() => void applyFlags('\\Seen', true)}
                onMarkUnread={() => void applyFlags('\\Seen', false)}
                onStar={() => void starSelected()}
                onTrash={() => void moveSelected()}
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
                emptyTitle={syncError ? 'Could not load mail' : 'No messages'}
                emptySub={
                  syncError
                    ? 'Check your connection and try again.'
                    : active
                      ? `${folderLabel(active.path, active.name)} is empty`
                      : ''
                }
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
      {undoToast ? (
        <UndoToast
          expiresAt={undoToast.expiresAt}
          label={`Sending${undoToast.subject ? ` “${undoToast.subject}”` : ''}`}
          onUndo={() => void onUndo(undoToast.outboxId)}
          onDismiss={() => setUndoToast(null)}
        />
      ) : moveToast ? (
        <UndoToast
          expiresAt={moveToast.expiresAt}
          label={moveToast.label}
          onUndo={() => void onUndoMove()}
          onDismiss={() => setMoveToast(null)}
        />
      ) : null}
    </div>
  )
}
