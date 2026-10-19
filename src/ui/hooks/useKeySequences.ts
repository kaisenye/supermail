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
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return

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
        first = e.key
        timer = setTimeout(disarm, timeoutMs)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      disarm()
    }
  }, [sequences, timeoutMs])
}
