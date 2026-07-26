import { useEffect } from 'react'

/**
 * Meta/Ctrl chords that useHotkeys deliberately ignores (command bar, send).
 */
export function useCommandChord(
  chords: { key: string; handler: (e: KeyboardEvent) => void }[]
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      for (const c of chords) {
        if (c.key.toLowerCase() !== key) continue
        e.preventDefault()
        c.handler(e)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chords])
}
