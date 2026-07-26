import { useEffect } from 'react'

export type Mode = 'list' | 'thread' | 'compose' | 'modal'

export interface Binding {
  /** Single character or key name (e.g. 'j', 'Enter', 'Escape'). */
  key: string
  handler: (e: KeyboardEvent) => void
  /** If set, only fires in these modes. Omit for all. */
  modes?: Mode[]
}

/** True when focus is in an editable field — typing must not trigger shortcuts. */
function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  )
}

/**
 * Central keyboard dispatcher. A single window listener resolves bindings
 * against the current mode, so views don't fight over keydown and the active
 * mode alone decides what a key does. Compose/modal deliberately swallow
 * navigation keys rather than letting the list react underneath them.
 */
export function useHotkeys(mode: Mode, bindings: Binding[]): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Modifier chords belong to the command bar / OS, not these bindings.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // Never hijack typing, except Escape which must always be reachable.
      if (isEditable(e.target) && e.key !== 'Escape') return

      for (const b of bindings) {
        if (b.key !== e.key) continue
        if (b.modes && !b.modes.includes(mode)) continue
        e.preventDefault()
        b.handler(e)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, bindings])
}
