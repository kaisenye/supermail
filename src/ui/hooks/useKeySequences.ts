import { useEffect } from 'react'

/**
 * Two-key sequences (g then i). `sequences` maps first key -> second key ->
 * action; an empty map leaves every key alone. Typing in a field never arms it.
 */
export function useKeySequences(
  sequences: Record<string, Record<string, () => void>>,
  timeoutMs = 1200
): void {
  useEffect(() => {
    let first: string | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const disarm = (): void => {
      first = null
      if (timer) clearTimeout(timer)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement
      if (
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' ||
        el.isContentEditable
      )
        return

      if (first) {
        const run = sequences[first]?.[e.key]
        disarm()
        if (run) {
          e.preventDefault()
          run()
        }
        return
      }
      if (sequences[e.key]) {
        // A sequence's first key is never a single-key binding (the registry
        // test enforces it), so claiming it here cannot steal a shortcut.
        e.preventDefault()
        first = e.key
        timer = setTimeout(disarm, timeoutMs)
      }
    }
    // Capture phase: a window capture listener runs before the bubble-phase
    // listeners useHotkeys and useCommandChord use, whatever the hook order. A
    // matched second key is marked defaultPrevented, so g s goes to Sent and
    // does not also star. An unmatched second key is left alone.
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      disarm()
    }
  }, [sequences, timeoutMs])
}
