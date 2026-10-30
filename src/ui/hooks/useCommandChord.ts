import { useEffect } from 'react'
import { isEditable } from './useHotkeys'

export interface Chord {
  key: string
  /** ⌘⇧ chords set this; a plain ⌘ chord does not fire with Shift held. */
  shift?: boolean
  handler: (e: KeyboardEvent) => void
}

type ChordEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/** The chord `e` triggers, if any. `inText`: focus is in an editable field. */
export function matchChord(chords: Chord[], e: ChordEvent, inText: boolean): Chord | undefined {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return undefined
  const key = e.key.toLowerCase()
  // ⌘A in a text field selects its text, not every row behind it.
  if (inText && key === 'a') return undefined
  return chords.find((c) => c.key.toLowerCase() === key && !!c.shift === e.shiftKey)
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
