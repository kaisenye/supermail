import { create } from 'zustand'
import type { Folder, MessageListRow } from '../core/store/types'
import type { ChipId } from './chips'

export interface ComposeAttachment {
  path: string
  filename: string
  contentType: string
  size: number
}

export interface ComposeState {
  draftId: number | null
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
  attachments: ComposeAttachment[]
  inReplyTo: string | null
  references: string | null
  mode: 'new' | 'reply' | 'replyAll' | 'forward'
  /** ⌘⇧H: "remind me if no reply" at this time, saved by main after the send. */
  remindAt: number | null
}

/** The single action `z` or the toast can still take back. Each new one replaces it. */
export interface UndoEntry {
  label: string
  expiresAt: number
  run: () => Promise<void>
}

interface AppState {
  email: string | null
  bootError: string | null
  folders: Folder[]
  activeFolderId: number | null
  rows: MessageListRow[]
  selectedIndex: number
  /** Multi-select (checkbox) ids — independent of keyboard cursor. */
  checkedIds: number[]
  lastCheckedIndex: number | null
  syncing: boolean
  syncLabel: string | null
  syncError: string | null
  hasSyncedOnce: boolean
  openThread: { threadId: string; messageId: number } | null
  paletteOpen: boolean
  compose: ComposeState | null
  undo: UndoEntry | null
  unread: Record<number, number>
  /** Local page cursor plus whether the server still has older mail. */
  loadingMore: boolean
  exhausted: boolean
  /** Zero-based page index within the active folder. */
  page: number
  /** Total rows behind the active folder, for the page indicator. */
  totalRows: number
  /** Active split in the Inbox ('all' = no split). */
  splitId: string
  /** Active filter chip, any folder. */
  chip: ChipId | null
  groupByDate: boolean

  openThreadView: (threadId: string, messageId: number) => void
  closeThread: () => void
  setBoot: (email: string | null, error: string | null) => void
  setFolders: (folders: Folder[]) => void
  setActiveFolder: (id: number) => void
  setRows: (rows: MessageListRow[]) => void
  setPageRows: (rows: MessageListRow[]) => void
  appendRows: (rows: MessageListRow[]) => void
  removeRows: (ids: number[]) => { index: number; row: MessageListRow }[]
  restoreRows: (removed: { index: number; row: MessageListRow }[]) => void
  updateRowFlags: (id: number, flags: string) => void
  markRowSeen: (id: number) => void
  setSelectedIndex: (i: number) => void
  moveSelection: (delta: number) => void
  toggleChecked: (id: number, index: number) => void
  checkRange: (toIndex: number) => void
  setCheckedAll: (ids: number[]) => void
  clearChecked: () => void
  setSync: (syncing: boolean, label?: string | null) => void
  setSyncError: (error: string | null) => void
  /**
   * A triage action that could not run (no Done folder, not Gmail, …). Kept
   * apart from syncError: it is not a sync failure, and must not turn the
   * empty list into "Could not load mail" or block the inbox-zero state.
   */
  actionError: string | null
  setActionError: (error: string | null) => void
  setSyncedOnce: () => void
  openPalette: () => void
  closePalette: () => void
  openCompose: (state: ComposeState) => void
  updateCompose: (patch: Partial<ComposeState>) => void
  closeCompose: () => void
  setUndo: (u: UndoEntry | null) => void
  setUnread: (unread: Record<number, number>) => void
  setLoadingMore: (loading: boolean) => void
  setExhausted: (exhausted: boolean) => void
  setPage: (page: number) => void
  setTotalRows: (totalRows: number) => void
  setSplit: (id: string) => void
  setChip: (chip: ChipId | null) => void
  setGroupByDate: (on: boolean) => void
  /** ⇧J / ⇧K: check the cursor row and the next one, and move the cursor there. */
  extendSelection: (delta: number) => void
}

export function emptyCompose(): ComposeState {
  return {
    draftId: null,
    to: '',
    cc: '',
    bcc: '',
    subject: '',
    body: '',
    attachments: [],
    inReplyTo: null,
    references: null,
    mode: 'new',
    remindAt: null
  }
}

/** activeFolderId sentinel for the Reminders view, which is not an IMAP folder. */
export const REMINDERS_VIEW_ID = -1

export const useStore = create<AppState>((set, get) => ({
  email: null,
  bootError: null,
  folders: [],
  activeFolderId: null,
  rows: [],
  selectedIndex: 0,
  checkedIds: [],
  lastCheckedIndex: null,
  syncing: false,
  syncLabel: null,
  syncError: null,
  actionError: null,
  hasSyncedOnce: false,
  openThread: null,
  paletteOpen: false,
  compose: null,
  undo: null,
  unread: {},
  loadingMore: false,
  exhausted: false,
  page: 0,
  totalRows: 0,
  splitId: 'all',
  chip: null,
  groupByDate: false,

  openThreadView: (threadId, messageId) => set({ openThread: { threadId, messageId } }),
  closeThread: () => set({ openThread: null }),
  setBoot: (email, bootError) => set({ email, bootError }),
  setFolders: (folders) => set({ folders }),
  setActiveFolder: (activeFolderId) =>
    set({
      activeFolderId,
      selectedIndex: 0,
      checkedIds: [],
      lastCheckedIndex: null,
      exhausted: false,
      page: 0,
      totalRows: 0
    }),
  setRows: (rows) =>
    set((s) => {
      const idSet = new Set(rows.map((r) => r.id))
      return {
        rows,
        selectedIndex: Math.min(s.selectedIndex, Math.max(0, rows.length - 1)),
        checkedIds: s.checkedIds.filter((id) => idSet.has(id))
      }
    }),
  /** Swapping to a whole new page: cursor to the top, selection cleared. */
  setPageRows: (rows) =>
    set({ rows, selectedIndex: 0, checkedIds: [], lastCheckedIndex: null }),
  appendRows: (incoming) =>
    set((s) => {
      // A concurrent sync can land a row the previous page already has.
      const have = new Set(s.rows.map((r) => r.id))
      const fresh = incoming.filter((r) => !have.has(r.id))
      return fresh.length ? { rows: [...s.rows, ...fresh] } : {}
    }),
  removeRows: (ids) => {
    const drop = new Set(ids)
    const removed = get()
      .rows.map((row, index) => ({ index, row }))
      .filter((x) => drop.has(x.row.id))
    if (!removed.length) return []
    set((s) => {
      const rows = s.rows.filter((r) => !drop.has(r.id))
      return {
        rows,
        selectedIndex: Math.min(s.selectedIndex, Math.max(0, rows.length - 1)),
        checkedIds: s.checkedIds.filter((id) => !drop.has(id)),
        lastCheckedIndex: null,
        // The pager and the inbox-zero check read this, not rows.length.
        totalRows: Math.max(0, s.totalRows - removed.length)
      }
    })
    return removed
  },
  /**
   * Re-insert at the original indices. Ascending order means each splice sees
   * the list already rebuilt below it, so earlier positions stay correct.
   */
  restoreRows: (removed) =>
    set((s) => {
      const rows = [...s.rows]
      for (const { index, row } of [...removed].sort((a, b) => a.index - b.index)) {
        rows.splice(Math.min(index, rows.length), 0, row)
      }
      return { rows, totalRows: s.totalRows + removed.length }
    }),
  updateRowFlags: (id, flags) =>
    set((s) => ({ rows: s.rows.map((r) => (r.id === id ? { ...r, flags } : r)) })),
  markRowSeen: (id) =>
    set((s) => ({
      rows: s.rows.map((r) => {
        if (r.id !== id) return r
        const flags: string[] = r.flags ? JSON.parse(r.flags) : []
        if (flags.some((f) => f.toLowerCase() === '\\seen')) return r
        return { ...r, flags: JSON.stringify([...flags, '\\Seen']) }
      })
    })),
  // A plain click re-anchors the range: shift extends from the last row the
  // user pointed at, not from a checkbox they may have since cleared.
  setSelectedIndex: (selectedIndex) => set({ selectedIndex, lastCheckedIndex: selectedIndex }),
  moveSelection: (delta) => {
    const { rows, selectedIndex } = get()
    if (!rows.length) return
    const next = Math.max(0, Math.min(rows.length - 1, selectedIndex + delta))
    // Re-anchors like a click: j/k then shift-click ranges from where you are.
    if (next !== selectedIndex) set({ selectedIndex: next, lastCheckedIndex: next })
  },
  toggleChecked: (id, index) =>
    set((s) => {
      const has = s.checkedIds.includes(id)
      return {
        checkedIds: has ? s.checkedIds.filter((x) => x !== id) : [...s.checkedIds, id],
        lastCheckedIndex: index,
        selectedIndex: index
      }
    }),
  checkRange: (toIndex) => {
    const { rows, lastCheckedIndex, selectedIndex, checkedIds } = get()
    const from = lastCheckedIndex ?? selectedIndex
    const lo = Math.min(from, toIndex)
    const hi = Math.max(from, toIndex)
    const next = new Set(checkedIds)
    for (let i = lo; i <= hi; i++) {
      const row = rows[i]
      if (row) next.add(row.id)
    }
    set({
      checkedIds: [...next],
      lastCheckedIndex: toIndex,
      selectedIndex: toIndex
    })
  },
  setCheckedAll: (ids) => set({ checkedIds: ids, lastCheckedIndex: null }),
  clearChecked: () => set({ checkedIds: [], lastCheckedIndex: null }),
  setSync: (syncing, syncLabel = null) => set({ syncing, syncLabel }),
  setSyncError: (syncError) => set({ syncError }),
  setActionError: (actionError) => set({ actionError }),
  setSyncedOnce: () => set({ hasSyncedOnce: true }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  openCompose: (compose) => set({ compose, paletteOpen: false }),
  updateCompose: (patch) => {
    const cur = get().compose
    if (!cur) return
    set({ compose: { ...cur, ...patch } })
  },
  closeCompose: () => set({ compose: null }),
  setUndo: (undo) => set({ undo }),
  setUnread: (unread) => set({ unread }),
  setLoadingMore: (loadingMore) => set({ loadingMore }),
  setExhausted: (exhausted) => set({ exhausted }),
  setPage: (page) => set({ page }),
  setTotalRows: (totalRows) => set({ totalRows }),
  setSplit: (splitId) => set({ splitId }),
  setChip: (chip) => set({ chip }),
  setGroupByDate: (groupByDate) => set({ groupByDate }),
  extendSelection: (delta) => {
    const { rows, selectedIndex, checkedIds } = get()
    if (!rows.length) return
    const next = Math.max(0, Math.min(rows.length - 1, selectedIndex + delta))
    const ids = new Set(checkedIds)
    if (rows[selectedIndex]) ids.add(rows[selectedIndex].id)
    if (rows[next]) ids.add(rows[next].id)
    set({ checkedIds: [...ids], selectedIndex: next, lastCheckedIndex: next })
  }
}))
