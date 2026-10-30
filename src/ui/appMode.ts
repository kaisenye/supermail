import type { Mode } from './hooks/useHotkeys'

interface Surface {
  compose: boolean
  /** Tasks replaces the mail pane, so mail keys must not reach the hidden list. */
  tasksOpen: boolean
  openThread: boolean
  /** The search page is on screen (an open thread still wins). */
  searchOpen?: boolean
}

/**
 * The mode under any palette or dialog. The palette passes this to its
 * commands, since its own mode is always 'modal' and would send a thread's
 * Done to the list cursor instead.
 */
export function baseMode(s: Surface): Mode {
  if (s.compose) return 'compose'
  if (s.tasksOpen) return 'modal'
  if (s.openThread) return 'thread'
  return s.searchOpen ? 'search' : 'list'
}

/** The keyboard mode: any open palette, dialog or picker owns the keys. */
export function appMode(s: Surface & { overlayOpen: boolean }): Mode {
  return s.overlayOpen ? 'modal' : baseMode(s)
}
