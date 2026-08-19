import { create } from 'zustand'
import type { Folder, MessageListRow } from '../core/store/types'

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
}

export interface UndoToast {
  outboxId: number
  subject: string
  expiresAt: number
}

/** Trash undo. Rows are held here so undo can restore their position. */
export interface MoveToast {
  batchId: number
  label: string
  expiresAt: number
  removed: { index: number; row: MessageListRow }[]
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
  undoToast: UndoToast | null
  moveToast: MoveToast | null
  unread: Record<number, number>
  /** Local page cursor plus whether the server still has older mail. */
  loadingMore: boolean
  exhausted: boolean
  /** Zero-based page index within the active folder. */
  page: number
  /** Total rows behind the active folder, for the page indicator. */
  totalRows: number

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
  setSyncedOnce: () => void
  openPalette: () => void
  closePalette: () => void
  openCompose: (state: ComposeState) => void
  updateCompose: (patch: Partial<ComposeState>) => void
  closeCompose: () => void
  setUndoToast: (toast: UndoToast | null) => void
  setMoveToast: (toast: MoveToast | null) => void
  setUnread: (unread: Record<number, number>) => void
  setLoadingMore: (loading: boolean) => void
  setExhausted: (exhausted: boolean) => void
  setPage: (page: number) => void
  setTotalRows: (totalRows: number) => void
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
    mode: 'new'
  }
}

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
  hasSyncedOnce: false,
  openThread: null,
  paletteOpen: false,
  compose: null,
  undoToast: null,
  moveToast: null,
  unread: {},
  loadingMore: false,
  exhausted: false,
  page: 0,
  totalRows: 0,

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
        lastCheckedIndex: null
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
      return { rows }
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
  setUndoToast: (undoToast) => set({ undoToast }),
  setMoveToast: (moveToast) => set({ moveToast }),
  setUnread: (unread) => set({ unread }),
  setLoadingMore: (loadingMore) => set({ loadingMore }),
  setExhausted: (exhausted) => set({ exhausted }),
  setPage: (page) => set({ page }),
  setTotalRows: (totalRows) => set({ totalRows })
}))
