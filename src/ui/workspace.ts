import type { ChipId } from './chips'

/**
 * What one tab shows: a folder or special view (folderId is a folder id, or a
 * negative *_VIEW_ID sentinel), the split and chip on it, an optional open
 * thread, and the search page's query.
 */
export interface View {
  folderId: number
  splitId: string
  chip: ChipId | null
  thread: { threadId: string; messageId: number; accountId?: number } | null
  query?: string
}

/** history[index] is on screen; entries after it are "forward". */
export interface Tab {
  id: number
  history: View[]
  index: number
}

export interface Workspace {
  tabs: Tab[]
  active: number
  nextId: number
}

/** ⌘1–⌘9 reach every tab. */
export const MAX_TABS = 9
export const MAX_HISTORY = 50

/** Same place on screen. A thread is the same place whichever of its messages is focused. */
export function sameView(a: View, b: View): boolean {
  return (
    a.folderId === b.folderId &&
    a.splitId === b.splitId &&
    a.chip === b.chip &&
    (a.query ?? '') === (b.query ?? '') &&
    (a.thread?.threadId ?? null) === (b.thread?.threadId ?? null) &&
    (a.thread?.accountId ?? null) === (b.thread?.accountId ?? null)
  )
}

export function initWorkspace(view: View): Workspace {
  return { tabs: [{ id: 1, history: [view], index: 0 }], active: 0, nextId: 2 }
}

export function currentView(ws: Workspace): View {
  const t = ws.tabs[ws.active]
  return t.history[t.index]
}

function withTab(ws: Workspace, tab: Tab): Workspace {
  const tabs = ws.tabs.slice()
  tabs[ws.active] = tab
  return { ...ws, tabs }
}

/** A step to a new place: drops forward entries. Returns `ws` itself when nothing changed. */
export function navigate(ws: Workspace, view: View): Workspace {
  const t = ws.tabs[ws.active]
  if (sameView(t.history[t.index], view)) return ws
  const history = [...t.history.slice(0, t.index + 1), view].slice(-MAX_HISTORY)
  return withTab(ws, { ...t, history, index: history.length - 1 })
}

/** Rewrites the current entry without adding a step. */
export function replaceCurrent(ws: Workspace, view: View): Workspace {
  const t = ws.tabs[ws.active]
  const history = t.history.slice()
  history[t.index] = view
  return withTab(ws, { ...t, history })
}

/**
 * What App calls after any navigation. Typing in the search page changes only
 * the query, which edits the current entry; anything else is a step.
 */
export function record(ws: Workspace, view: View): Workspace {
  const cur = currentView(ws)
  const queryOnly =
    cur.folderId === view.folderId &&
    cur.thread === null &&
    view.thread === null &&
    (cur.query ?? '') !== (view.query ?? '') &&
    sameView({ ...cur, query: view.query }, view)
  return queryOnly ? replaceCurrent(ws, view) : navigate(ws, view)
}

export function canGoBack(ws: Workspace): boolean {
  return ws.tabs[ws.active].index > 0
}

export function canGoForward(ws: Workspace): boolean {
  const t = ws.tabs[ws.active]
  return t.index < t.history.length - 1
}

export function back(ws: Workspace): Workspace | null {
  const t = ws.tabs[ws.active]
  return t.index > 0 ? withTab(ws, { ...t, index: t.index - 1 }) : null
}

/**
 * Back past every entry on `folderId` (threads opened from it included), to
 * the place it was entered from. Null when the tab has nowhere before it.
 */
export function backOutOf(ws: Workspace, folderId: number): Workspace | null {
  let prev = back(ws)
  while (prev && currentView(prev).folderId === folderId) prev = back(prev)
  return prev
}

export function forward(ws: Workspace): Workspace | null {
  const t = ws.tabs[ws.active]
  return t.index < t.history.length - 1 ? withTab(ws, { ...t, index: t.index + 1 }) : null
}

/** A new tab right after the active one, made active. At MAX_TABS nothing happens. */
export function openTab(ws: Workspace, view: View): Workspace {
  if (ws.tabs.length >= MAX_TABS) return ws
  const tab: Tab = { id: ws.nextId, history: [view], index: 0 }
  const tabs = [...ws.tabs.slice(0, ws.active + 1), tab, ...ws.tabs.slice(ws.active + 1)]
  return { tabs, active: ws.active + 1, nextId: ws.nextId + 1 }
}

/** Null when it is the last tab: there is always one. */
export function closeTab(ws: Workspace, index = ws.active): Workspace | null {
  if (ws.tabs.length <= 1 || index < 0 || index >= ws.tabs.length) return null
  const tabs = ws.tabs.filter((_, i) => i !== index)
  const active =
    index < ws.active ? ws.active - 1 : index === ws.active ? Math.min(index, tabs.length - 1) : ws.active
  return { ...ws, tabs, active }
}

/** ⌘1–⌘8 pick that tab; ⌘9 (index 8) is always the last one, as in a browser. */
export function selectTab(ws: Workspace, index: number): Workspace {
  const i = index >= 8 ? ws.tabs.length - 1 : index
  if (i < 0 || i >= ws.tabs.length || i === ws.active) return ws
  return { ...ws, active: i }
}

export function cycleTab(ws: Workspace, delta: number): Workspace {
  const n = ws.tabs.length
  return n < 2 ? ws : { ...ws, active: (ws.active + delta + n) % n }
}

/**
 * Each account keeps its own tabs: switching accounts (⌃1–9) reloads the
 * window, and one shared key would be overwritten by the other account's
 * fallback tab.
 */
export function workspaceKey(accountId: number | null): string {
  return accountId === null ? 'workspace' : `account.${accountId}.workspace`
}

/** The account's saved workspace. The old global key only seeds an account that has none yet. */
export function savedWorkspace(settings: Record<string, string>, accountId: number | null): string | undefined {
  return settings[workspaceKey(accountId)] ?? settings.workspace
}

export function serializeWorkspace(ws: Workspace): string {
  return JSON.stringify(ws)
}

function isView(v: unknown): v is View {
  const x = v as View | null
  if (!x || typeof x.folderId !== 'number' || typeof x.splitId !== 'string') return false
  if (x.chip !== null && typeof x.chip !== 'string') return false
  if (x.query !== undefined && typeof x.query !== 'string') return false
  const t = x.thread
  return t === null || (!!t && typeof t.threadId === 'string' && typeof t.messageId === 'number')
}

/**
 * settings.workspace, keeping only views `valid` accepts (a folder may be gone,
 * or belong to another account after a switch). Anything unusable yields one
 * tab on `fallback`.
 */
export function restoreWorkspace(json: string | undefined, valid: (v: View) => boolean, fallback: View): Workspace {
  let raw: unknown
  try {
    raw = json ? JSON.parse(json) : null
  } catch {
    raw = null
  }
  const src = raw as Partial<Workspace> | null
  if (!src || !Array.isArray(src.tabs)) return initWorkspace(fallback)
  const tabs: Tab[] = []
  let active = 0
  src.tabs.forEach((t, i) => {
    if (!t || typeof t.id !== 'number' || !Array.isArray(t.history)) return
    const history = t.history.filter((v) => isView(v) && valid(v))
    if (!history.length) return
    const index = Math.max(0, Math.min(typeof t.index === 'number' ? t.index : 0, history.length - 1))
    if (i === src.active) active = tabs.length
    tabs.push({ id: t.id, history, index })
  })
  if (!tabs.length) return initWorkspace(fallback)
  const nextId = Math.max(...tabs.map((t) => t.id)) + 1
  return { tabs: tabs.slice(0, MAX_TABS), active: Math.min(active, tabs.length - 1), nextId }
}
