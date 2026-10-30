import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MessageListRow } from '../../core/store/types'
import type { AskSource } from '../../../electron/preload'
import { formatDate, senderLabel } from '../format'
import { isImeKey } from '../ime'
import { requestGate } from '../latest'

export interface PaletteAction {
  id: string
  label: string
  hint?: string
  run: () => void | Promise<void>
}

interface Props {
  open: boolean
  /** Open straight into Ask AI (⌘J). ⇥ switches either way. */
  startInAsk: boolean
  actions: PaletteAction[]
  onClose: () => void
  onOpenMessage: (threadId: string, messageId: number, accountId?: number) => void
}

type Item =
  | { kind: 'action'; action: PaletteAction }
  | { kind: 'message'; row: MessageListRow }

interface Answer {
  answer: string
  sources: AskSource[]
}

export function CommandPalette({ open, startInAsk, actions, onClose, onOpenMessage }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MessageListRow[]>([])
  const [selected, setSelected] = useState(0)
  const [searching, setSearching] = useState(false)
  const [asking, setAsking] = useState(false)
  const [askBusy, setAskBusy] = useState(false)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [askError, setAskError] = useState<string | null>(null)
  // A reply that lands after the palette closed or ⇥ switched modes is dropped.
  const [askGate] = useState(requestGate)

  useEffect(() => {
    if (!open) {
      askGate.cancel()
      setQuery('')
      setResults([])
      setSelected(0)
      setAnswer(null)
      setAskError(null)
      setAskBusy(false)
      return
    }
    setAsking(startInAsk)
    const t = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(t)
  }, [open, startInAsk, askGate])

  useEffect(() => {
    if (!open || asking) return
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
  }, [query, open, asking])

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

  // In Ask mode nothing is selected until ↓ picks a source, so ↵ asks.
  useEffect(() => {
    setSelected(asking ? -1 : 0)
  }, [query, results.length, filteredActions.length, asking])

  const activate = useCallback(
    (item: Item) => {
      if (item.kind === 'action') {
        void item.action.run()
        onClose()
        return
      }
      if (item.row.thread_id) {
        onOpenMessage(item.row.thread_id, item.row.id, item.row.account_id)
        onClose()
      }
    },
    [onClose, onOpenMessage]
  )

  const ask = useCallback(async () => {
    const q = query.trim()
    if (!q || askBusy) return
    setAskBusy(true)
    setAskError(null)
    setAnswer(null)
    const current = askGate.start()
    const r = await window.api.aiAsk(q)
    if (!current()) return
    setAskBusy(false)
    if (!r.ok) return setAskError(r.error)
    setAnswer({ answer: r.answer, sources: r.sources })
    setSelected(-1)
  }, [query, askBusy, askGate])

  const openSource = useCallback(
    (s: AskSource) => {
      if (!s.thread_id) return
      onOpenMessage(s.thread_id, s.id, s.account_id)
      onClose()
    },
    [onOpenMessage, onClose]
  )

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      // The Enter that confirms a Pinyin candidate must not fire an Ask (a paid request) or a command.
      if (isImeKey(e)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        askGate.cancel()
        setAsking((a) => !a)
        setAnswer(null)
        setAskError(null)
        setAskBusy(false)
        return
      }
      if (asking) {
        const n = answer?.sources.length ?? 0
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelected((i) => Math.min(n - 1, i + 1))
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelected((i) => Math.max(-1, i - 1))
        } else if (e.key === 'Enter') {
          e.preventDefault()
          const s = answer && selected >= 0 ? answer.sources[selected] : null
          if (s) openSource(s)
          else void ask()
        }
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
  }, [open, items, selected, activate, onClose, asking, answer, ask, openSource, askGate])

  if (!open) return null

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label={asking ? 'Ask AI' : 'Command palette'}
        data-mode={asking ? 'ask' : 'commands'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={asking ? 'Ask about your mail…' : 'Search mail or jump…'}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="palette-list">
          {asking ? (
            askBusy ? (
              <div className="palette-empty">Thinking…</div>
            ) : askError ? (
              <div className="palette-empty palette-error">{askError}</div>
            ) : answer ? (
              <>
                <p className="palette-answer">{answer.answer}</p>
                {answer.sources.map((s, i) => (
                  <button
                    key={`s-${s.account_id}-${s.id}`}
                    type="button"
                    className="palette-row"
                    data-selected={i === selected}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => openSource(s)}
                  >
                    <span className="palette-row-hint">[{s.n}]</span>
                    <span className="palette-row-sender">{senderLabel(s.from_name, s.from_addr)}</span>
                    <span className="palette-row-subject">{s.subject || '(no subject)'}</span>
                    <span className="palette-row-hint">{formatDate(s.date)}</span>
                  </button>
                ))}
              </>
            ) : (
              <div className="palette-empty">
                Ask a question and press ↵. The answer comes from your local mail; the matching
                messages go to your AI provider.
              </div>
            )
          ) : items.length === 0 ? (
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
        <div className="palette-foot">⇥ {asking ? 'Commands and search' : 'Ask AI'}</div>
      </div>
    </div>
  )
}
