import { create } from 'zustand'

/**
 * The app's one notification surface. Everything transient (an action's
 * error, a failed sync, a held move you can undo, a reconnect prompt) is a
 * toast here, so they look, move and stack the same way. Rendered by
 * `views/Toaster.tsx` at the bottom centre of the content pane.
 */
export type ToastKind = 'info' | 'success' | 'warning' | 'error' | 'undo'

export interface ToastAction {
  label: string
  run: () => void
}

export interface ToastInput {
  /** A toast with the same key is replaced in place (one sync error, one undo). */
  key?: string
  kind?: ToastKind
  title: string
  /** A second, quieter line. */
  detail?: string
  action?: ToastAction
  /** How long it stays, in ms; null stays until dismissed. Defaults per kind. */
  duration?: number | null
  /** Called when it times out (not when dismissed by hand). */
  onExpire?: () => void
}

export interface Toast extends ToastInput {
  id: number
  kind: ToastKind
  /** When the current timer ends (for the undo bar); null when sticky. */
  endsAt: number | null
  /** Playing its exit; removed once that finishes. */
  leaving: boolean
}

const DEFAULT_MS: Record<ToastKind, number | null> = {
  info: 4000,
  success: 4000,
  warning: 6000,
  error: 7000,
  undo: 5000
}
/** How long the exit plays before the toast is removed (matches the CSS). */
export const TOAST_EXIT_MS = 220
/** More than this and the oldest go. */
const MAX_TOASTS = 5

interface ToastState {
  toasts: Toast[]
}

export const useToasts = create<ToastState>(() => ({ toasts: [] }))

let nextId = 1
const timers = new Map<number, { handle: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number }>()
let paused = false

function find(keyOrId: string | number): Toast | undefined {
  return useToasts
    .getState()
    .toasts.find((t) => !t.leaving && (typeof keyOrId === 'number' ? t.id === keyOrId : t.key === keyOrId))
}

function patch(id: number, p: Partial<Toast>): void {
  useToasts.setState((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...p } : t)) }))
}

function clearTimer(id: number): void {
  const t = timers.get(id)
  if (t?.handle) clearTimeout(t.handle)
  timers.delete(id)
}

/** Undo counts down whatever the pointer does: the move it holds fires on schedule in main. */
const pausable = (t: Toast): boolean => t.kind !== 'undo'

function arm(t: Toast, ms: number): void {
  clearTimer(t.id)
  const run = !(paused && pausable(t))
  timers.set(t.id, {
    handle: run ? setTimeout(() => expire(t.id), ms) : null,
    remaining: ms,
    startedAt: Date.now()
  })
  patch(t.id, { endsAt: run ? Date.now() + ms : null })
}

function expire(id: number): void {
  const t = useToasts.getState().toasts.find((x) => x.id === id)
  timers.delete(id)
  if (!t || t.leaving) return
  remove(id)
  t.onExpire?.()
}

function remove(id: number): void {
  clearTimer(id)
  patch(id, { leaving: true })
  setTimeout(() => useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), TOAST_EXIT_MS)
}

/** Shows a toast, or updates the one with the same key. Returns its id. */
export function showToast(input: ToastInput): number {
  const kind = input.kind ?? 'info'
  const duration = input.duration === undefined ? DEFAULT_MS[kind] : input.duration
  const existing = input.key ? find(input.key) : undefined
  let t: Toast
  if (existing) {
    t = { ...existing, ...input, kind, leaving: false }
    patch(existing.id, t)
  } else {
    t = { ...input, kind, id: nextId++, endsAt: null, leaving: false }
    useToasts.setState((s) => {
      const live = s.toasts.filter((x) => !x.leaving)
      // Too many: the oldest leaves to make room.
      if (live.length >= MAX_TOASTS) queueMicrotask(() => remove(live[0].id))
      return { toasts: [...s.toasts, t] }
    })
  }
  if (duration === null) {
    clearTimer(t.id)
    patch(t.id, { endsAt: null })
  } else arm(t, duration)
  return t.id
}

/** Dismisses by key or id; a no-op when it is already gone. */
export function dismissToast(keyOrId: string | number): void {
  const t = find(keyOrId)
  if (t) remove(t.id)
}

/** The pointer is over the stack: hold every timer but undo's. */
export function pauseToasts(): void {
  if (paused) return
  paused = true
  for (const t of useToasts.getState().toasts) {
    const timer = timers.get(t.id)
    if (!timer?.handle || !pausable(t)) continue
    clearTimeout(timer.handle)
    timer.handle = null
    timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt))
    patch(t.id, { endsAt: null })
  }
}

export function resumeToasts(): void {
  if (!paused) return
  paused = false
  for (const t of useToasts.getState().toasts) {
    const timer = timers.get(t.id)
    if (timer && !timer.handle && !t.leaving) arm(t, Math.max(600, timer.remaining))
  }
}

/** Shorthands for the common kinds. */
export const toast = {
  info: (title: string, o: Omit<ToastInput, 'title' | 'kind'> = {}) => showToast({ ...o, title, kind: 'info' }),
  success: (title: string, o: Omit<ToastInput, 'title' | 'kind'> = {}) => showToast({ ...o, title, kind: 'success' }),
  warning: (title: string, o: Omit<ToastInput, 'title' | 'kind'> = {}) => showToast({ ...o, title, kind: 'warning' }),
  error: (title: string, o: Omit<ToastInput, 'title' | 'kind'> = {}) => showToast({ ...o, title, kind: 'error' }),
  dismiss: dismissToast
}

/** Tests: start from nothing. */
export function resetToasts(): void {
  for (const id of [...timers.keys()]) clearTimer(id)
  paused = false
  useToasts.setState({ toasts: [] })
}
