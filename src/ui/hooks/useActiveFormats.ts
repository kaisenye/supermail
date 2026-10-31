import { useCallback, useEffect, useState, type RefObject } from 'react'

/** Which formats are on at the caret, keyed like the toolbar buttons. */
export type FormatState = Record<string, boolean>

/** execCommand reports these itself. */
const COMMANDS = ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList']
/** These the browser does not report, so look for the element around the caret. */
const WRAPPERS: Record<string, string> = {
  strike: 's, strike, del',
  h1: 'h1',
  h2: 'h2',
  blockquote: 'blockquote',
  pre: 'pre'
}

export function readFormats(root: HTMLElement | null): FormatState {
  const node = window.getSelection()?.anchorNode ?? null
  if (!root || !node || !root.contains(node)) return {}
  const out: FormatState = {}
  for (const c of COMMANDS) out[c] = document.queryCommandState(c)
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  for (const [key, sel] of Object.entries(WRAPPERS)) {
    const hit = el?.closest(sel)
    out[key] = !!hit && root.contains(hit)
  }
  return out
}

const same = (a: FormatState, b: FormatState): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (!!a[k] !== !!b[k]) return false
  return true
}

/**
 * Keeps toolbar buttons pressed while their format is on at the caret.
 * Follows selection changes; call `refresh` after a command, since toggling
 * bold on a collapsed caret moves no selection.
 */
export function useActiveFormats(ref: RefObject<HTMLElement | null>): [FormatState, () => void] {
  const [active, setActive] = useState<FormatState>({})
  const refresh = useCallback(() => {
    const next = readFormats(ref.current)
    setActive((prev) => (same(prev, next) ? prev : next))
  }, [ref])
  useEffect(() => {
    document.addEventListener('selectionchange', refresh)
    return () => document.removeEventListener('selectionchange', refresh)
  }, [refresh])
  return [active, refresh]
}
