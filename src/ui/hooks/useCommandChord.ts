import { useEffect } from 'react'
import { isEditable } from './useHotkeys'

export interface Chord {
  key: string
  /** ⌘⇧ chords set this; a plain ⌘ chord does not fire with Shift held. */
  shift?: boolean
  /** The physical Control key alone (⌃1, ⌃Tab), never ⌘. */
  ctrl?: boolean
  handler: (e: KeyboardEvent) => void
}

type ChordEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/**
 * The chord `e` triggers, if any. `inText`: focus is in an editable field.
 * A ⌃ chord is matched first, so where ⌘ is Ctrl (off macOS) ⌃1 still
 * switches accounts rather than tabs.
 */
export function matchChord(chords: Chord[], e: ChordEvent, inText: boolean): Chord | undefined {
  if (e.altKey) return undefined
  const key = e.key.toLowerCase()
  if (e.ctrlKey && !e.metaKey) {
    const c = chords.find((x) => x.ctrl && x.key.toLowerCase() === key && !!x.shift === e.shiftKey)
    if (c) return c
  }
  if (!(e.metaKey || e.ctrlKey)) return undefined
  // ⌘A in a text field selects its text, not every row behind it; ⌘← / ⌘→
  // move its caret to the line's start or end, not to another page.
  if (inText && (key === 'a' || key === 'arrowleft' || key === 'arrowright')) return undefined
  return chords.find((x) => !x.ctrl && x.key.toLowerCase() === key && !!x.shift === e.shiftKey)
}

/**
 * Meta/Ctrl chords that useHotkeys deliberately ignores (command bar, send).
 */
export function useCommandChord(chords: Chord[]): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A key sequence (g then i) already consumed this key.
      if (e.defaultPrevented) return
      const c = matchChord(chords, e, isEditable(e.target))
      if (!c) return
      e.preventDefault()
      c.handler(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chords])
}
