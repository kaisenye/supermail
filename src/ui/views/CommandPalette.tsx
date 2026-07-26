import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MessageListRow } from '../../core/store/types'
import { formatDate, senderLabel } from '../format'

export interface PaletteAction {
  id: string
  label: string
  hint?: string
  run: () => void | Promise<void>
}

interface Props {
  open: boolean
  actions: PaletteAction[]
  onClose: () => void
  onOpenMessage: (threadId: string, messageId: number) => void
}

type Item =
  | { kind: 'action'; action: PaletteAction }
  | { kind: 'message'; row: MessageListRow }

export function CommandPalette({ open, actions, onClose, onOpenMessage }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MessageListRow[]>([])
  const [selected, setSelected] = useState(0)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (!open) {
      setQuery('')
      setResults([])
      setSelected(0)
      return
    }
    const t = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (!q) {
      setResults([])
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      void window.api.search(q, 40).then((rows) => {
        if (cancelled) return
        setResults(rows)
        setSearching(false)
      })
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, open])

  const filteredActions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return actions
    return actions.filter(
      (a) => a.label.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)
    )
  }, [actions, query])

  const items = useMemo<Item[]>(() => {
    const list: Item[] = filteredActions.map((action) => ({ kind: 'action', action }))
    for (const row of results) list.push({ kind: 'message', row })
    return list
  }, [filteredActions, results])

  useEffect(() => {
    setSelected(0)
  }, [query, results.length, filteredActions.length])

  const activate = useCallback(
    (item: Item) => {
      if (item.kind === 'action') {
        void item.action.run()
        onClose()
        return
      }
      if (item.row.thread_id) {
        onOpenMessage(item.row.thread_id, item.row.id)
        onClose()
      }
    },
    [onClose, onOpenMessage]
  )

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected((i) => Math.min(items.length - 1, i + 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((i) => Math.max(0, i - 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const item = items[selected]
        if (item) activate(item)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, items, selected, activate, onClose])

  if (!open) return null

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search mail or jump…"
          spellCheck={false}
          autoComplete="off"
        />
        <div className="palette-list">
          {items.length === 0 ? (
            <div className="palette-empty">
              {searching
                ? 'Searching…'
                : query.trim()
                  ? 'No matches'
                  : 'Type to search, or pick a command'}
            </div>
          ) : (
            items.map((item, i) =>
              item.kind === 'action' ? (
                <button
                  key={`a-${item.action.id}`}
                  type="button"
                  className="palette-row"
                  data-selected={i === selected}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => activate(item)}
                >
                  <span className="palette-row-label">{item.action.label}</span>
                  {item.action.hint && (
                    <span className="palette-row-hint">{item.action.hint}</span>
                  )}
                </button>
              ) : (
                <button
                  key={`m-${item.row.id}`}
                  type="button"
                  className="palette-row"
                  data-selected={i === selected}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => activate(item)}
                >
                  <span className="palette-row-sender">
                    {senderLabel(item.row.from_name, item.row.from_addr)}
                  </span>
                  <span className="palette-row-subject">
                    {item.row.subject || '(no subject)'}
                  </span>
                  <span className="palette-row-hint">{formatDate(item.row.date)}</span>
                </button>
              )
            )
          )}
        </div>
      </div>
    </div>
  )
}
