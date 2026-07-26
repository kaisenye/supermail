import { create } from 'zustand'
import type { Folder, MessageListRow } from '../core/store/types'

export interface ComposeState {
  draftId: number | null
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
  inReplyTo: string | null
  references: string | null
  mode: 'new' | 'reply' | 'replyAll'
}

export interface UndoToast {
  outboxId: number
  subject: string
  expiresAt: number
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

  openThreadView: (threadId: string, messageId: number) => void
  closeThread: () => void
  setBoot: (email: string | null, error: string | null) => void
  setFolders: (folders: Folder[]) => void
  setActiveFolder: (id: number) => void
  setRows: (rows: MessageListRow[]) => void
  removeRows: (ids: number[]) => void
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
}

export function emptyCompose(): ComposeState {
  return {
    draftId: null,
    to: '',
    cc: '',
    bcc: '',
    subject: '',
    body: '',
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

  openThreadView: (threadId, messageId) => set({ openThread: { threadId, messageId } }),
  closeThread: () => set({ openThread: null }),
  setBoot: (email, bootError) => set({ email, bootError }),
  setFolders: (folders) => set({ folders }),
  setActiveFolder: (activeFolderId) =>
    set({ activeFolderId, selectedIndex: 0, checkedIds: [], lastCheckedIndex: null }),
  setRows: (rows) =>
    set((s) => {
      const idSet = new Set(rows.map((r) => r.id))
      return {
        rows,
        selectedIndex: Math.min(s.selectedIndex, Math.max(0, rows.length - 1)),
        checkedIds: s.checkedIds.filter((id) => idSet.has(id))
      }
    }),
  removeRows: (ids) => {
    const drop = new Set(ids)
    set((s) => {
      const rows = s.rows.filter((r) => !drop.has(r.id))
      return {
        rows,
        selectedIndex: Math.min(s.selectedIndex, Math.max(0, rows.length - 1)),
        checkedIds: s.checkedIds.filter((id) => !drop.has(id)),
        lastCheckedIndex: null
      }
    })
  },
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
  setSelectedIndex: (selectedIndex) => set({ selectedIndex }),
  moveSelection: (delta) => {
    const { rows, selectedIndex } = get()
    if (!rows.length) return
    const next = Math.max(0, Math.min(rows.length - 1, selectedIndex + delta))
    if (next !== selectedIndex) set({ selectedIndex: next })
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
  setUndoToast: (undoToast) => set({ undoToast })
}))
