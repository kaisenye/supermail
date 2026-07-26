import { useCallback, useEffect, useMemo } from 'react'
import { emptyCompose, useStore } from './store'
import { useHotkeys, type Binding, type Mode } from './hooks/useHotkeys'
import { useCommandChord } from './hooks/useCommandChord'
import { MessageList } from './views/MessageList'
import { ActionBar } from './views/ActionBar'
import { Sidebar } from './views/Sidebar'
import { Thread } from './views/Thread'
import { CommandPalette, type PaletteAction } from './views/CommandPalette'
import { Compose } from './views/Compose'
import { UndoToast } from './views/UndoToast'
import { folderLabel, isUnread } from './format'
import './styles/app.css'

function replySubject(subject: string | null): string {
  const s = (subject ?? '').trim()
  if (!s) return 'Re: '
  return /^re:/i.test(s) ? s : `Re: ${s}`
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
    setUndoToast
  } = useStore()

  const loadRows = useCallback(
    async (folderId: number) => setRows(await window.api.listMessages(folderId, 500)),
    [setRows]
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
      if (res.messages > 0 && after.activeFolderId) await loadRows(after.activeFolderId)
    } else if (res.error !== 'sync already running') {
      setSyncError(res.error)
    }
  }, [loadRows, setSyncError])

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
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [backgroundSync])

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
      const target = fresh.find((f) => f.path === 'INBOX') ?? fresh[0]
      if (target) {
        setActiveFolder(target.id)
        await loadRows(target.id)
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

  const openSelected = useCallback(() => {
    const { rows: r, selectedIndex: i } = useStore.getState()
    const row = r[i]
    if (row?.thread_id) openThreadAndRead(row.thread_id, row.id)
  }, [openThreadAndRead])

  /** Checked rows, or the keyboard cursor row when nothing is checked. */
  const targetIds = useCallback((): number[] => {
    const { checkedIds: c, rows: r, selectedIndex: i } = useStore.getState()
    if (c.length) return c
    const row = r[i]
    return row ? [row.id] : []
  }, [])

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
      } catch (e) {
        setSyncError((e as Error).message)
      }
    },
    [targetIds, updateRowFlags, setSyncError]
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
    async (kind: 'archive' | 'trash') => {
      const ids = targetIds()
      if (!ids.length) return
      if (typeof window.api.moveMessages !== 'function') {
        setSyncError('App needs restart — action APIs not loaded')
        return
      }
      try {
        const res = await window.api.moveMessages(ids, kind)
        if (!res.ok) {
          setSyncError(res.error)
          return
        }
        removeRows(res.moved)
        clearChecked()
      } catch (e) {
        setSyncError((e as Error).message)
      }
    },
    [targetIds, removeRows, clearChecked, setSyncError]
  )

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

  const startCompose = useCallback(() => {
    openCompose(emptyCompose())
  }, [openCompose])

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
        body: ''
      })
    },
    [openCompose]
  )

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

  const mode: Mode = paletteOpen
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
      { key: 'e', modes: ['list'], handler: () => void moveSelected('archive') },
      { key: '#', modes: ['list'], handler: () => void moveSelected('trash') },
      { key: 'u', modes: ['thread'], handler: closeThread },
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
      { key: 'a', modes: ['thread'], handler: () => void startReply(true) }
    ],
    [
      moveSelection,
      openSelected,
      starSelected,
      toggleReadSelected,
      toggleChecked,
      applyFlags,
      moveSelected,
      clearChecked,
      closeThread,
      openPalette,
      startCompose,
      startReply
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
        id: 'scheduled',
        label: 'Show scheduled sends',
        run: async () => {
          const rows = await window.api.listScheduled()
          if (!rows.length) {
            window.alert('No scheduled sends')
            return
          }
          const lines = rows
            .map((r) => {
              const when = new Date(r.send_at).toLocaleString()
              return `${when} — ${r.subject || '(no subject)'} → ${r.to_addrs}`
            })
            .join('\n')
          const cancel = window.confirm(`${lines}\n\nCancel the soonest scheduled send?`)
          if (cancel && rows[0]) {
            await window.api.cancelSend(rows[0].id)
          }
        }
      }
    ],
    [startCompose, gotoFolder, backgroundSync]
  )

  const onSent = useCallback(
    (outboxId: number, subject: string, undoMs: number) => {
      if (undoMs > 0 && undoMs <= 15_000) {
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

  return (
    <div className="app">
      <div className="titlebar-drag" />
      <Sidebar
        email={email}
        folders={folders}
        activeFolderId={activeFolderId}
        onSelect={onFolder}
      />
      <main className="main">
        {compose ? (
          <Compose compose={compose} onClose={closeCompose} onSent={onSent} />
        ) : openThread ? (
          <Thread
            threadId={openThread.threadId}
            focusMessageId={openThread.messageId}
            onBack={closeThread}
          />
        ) : (
          <>
            <header className="list-header">
              <h1 className="list-title">
                {active ? folderLabel(active.path, active.name) : 'Supermail'}
              </h1>
              <span className="list-meta">
                {rows.length}
                {syncing && syncLabel ? ` · ${syncLabel}` : ''}
              </span>
            </header>
            <div className="sync-bar" data-active={syncing} />
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
                onArchive={() => void moveSelected('archive')}
                onTrash={() => void moveSelected('trash')}
              />
            )}
            {rows.length === 0 && !hasSyncedOnce ? (
              <div className="list-scroll">
                <div className="empty">
                  <span className="empty-title">Syncing your mail…</span>
                  <span className="empty-sub">Fetching from {email}</span>
                </div>
              </div>
            ) : rows.length === 0 ? (
              <div className="list-scroll">
                <div className="empty">
                  <span className="empty-title">
                    {syncError ? 'Could not load mail' : 'No messages'}
                  </span>
                  <span className="empty-sub">
                    {syncError
                      ? 'Check your connection and try again.'
                      : active
                        ? `${folderLabel(active.path, active.name)} is empty`
                        : ''}
                  </span>
                </div>
              </div>
            ) : (
              <MessageList
                rows={rows}
                selectedIndex={selectedIndex}
                checkedIds={checkedIds}
                onSelect={setSelectedIndex}
                onToggleCheck={onToggleCheck}
                onOpen={(i) => {
                  const row = rows[i]
                  if (row?.thread_id) openThreadAndRead(row.thread_id, row.id)
                }}
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
      {undoToast && (
        <UndoToast
          toast={undoToast}
          onUndo={(id) => void onUndo(id)}
          onDismiss={() => setUndoToast(null)}
        />
      )}
    </div>
  )
}
