import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Task } from '../../../electron/preload'
import type { MessageListRow } from '../../core/store/types'
import { formatDate, senderLabel } from '../format'
import { restoreSearch, scopeStep, searchStatus, type SearchScope } from '../searchKeys'
import { useStore } from '../store'
import { stepIndex } from '../threadNav'

type Scope = SearchScope
const SCOPES: { id: Scope; label: string }[] = [
  { id: 'emails', label: 'Emails' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'tasks', label: 'Tasks' }
]

interface Props {
  query: string
  onQuery: (q: string) => void
  /** Any Gmail account: offer "Search the server". */
  hasGmail: boolean
  /** `emails` is the whole result list, so j/k in the thread can step through it. */
  onOpenMessage: (row: MessageListRow, emails: MessageListRow[]) => void
  onOpenTasks: () => void
}

/**
 * The unified search page *(Scape)*. Keys here are local, like the palette:
 * Tab switches scope, ↑↓ move, ↵ opens. Esc reaches the registry's escape
 * (mode 'search'), which goes back.
 *
 * Results, scope and cursor live in the store: the page unmounts while a
 * result is open, and coming back must repaint at once in the same place.
 */
export function SearchPage({ query, onQuery, hasGmail, onOpenMessage, onOpenTasks }: Props) {
  const [restored] = useState(() => restoreSearch(useStore.getState().searchCache, query))
  const [text, setText] = useState(query)
  const [scope, setScope] = useState<Scope>(restored?.scope ?? 'emails')
  const [emails, setEmails] = useState<MessageListRow[]>(restored?.emails ?? [])
  const [contacts, setContacts] = useState<{ address: string; name: string | null }[]>(restored?.contacts ?? [])
  const [tasks, setTasks] = useState<Task[]>(restored?.tasks ?? [])
  const [active, setActive] = useState(restored?.active ?? 0)
  /** The query the results on screen answer. */
  const [resultsFor, setResultsFor] = useState(restored?.query ?? '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [server, setServer] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const seq = useRef(0)
  const setSearchCache = useStore((s) => s.setSearchCache)

  useEffect(() => inputRef.current?.focus(), [])
  // Back / forward can bring another query.
  useEffect(() => setText(query), [query])

  useEffect(() => {
    setSearchCache({ query: resultsFor, scope, active, emails, contacts, tasks })
  }, [setSearchCache, resultsFor, scope, active, emails, contacts, tasks])

  // Keep the cursor row on screen as ↑↓ move it.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, scope])

  // Debounced like the palette; a sequence number drops answers to older queries.
  useEffect(() => {
    const q = text.trim()
    // Already showing these results (back from a thread): no refetch, no flash.
    if (q === resultsFor) return
    const t = setTimeout(() => {
      onQuery(text)
      const n = ++seq.current
      setActive(0)
      setServer(null)
      setError(null)
      setResultsFor(q)
      if (!q) {
        setLoading(false)
        setEmails([])
        setContacts([])
        setTasks([])
        return
      }
      setLoading(true)
      const fail = (e: unknown): void => {
        if (n === seq.current) setError((e as Error)?.message ?? String(e))
      }
      void Promise.allSettled([
        window.api.searchAll(q, 100).then((r) => n === seq.current && setEmails(r), fail),
        window.api.searchContacts(q, 20).then((r) => n === seq.current && setContacts(r), fail),
        window.api.searchTasks(q, 50).then((r) => n === seq.current && setTasks(r), fail)
      ]).then(() => n === seq.current && setLoading(false))
    }, 150)
    return () => clearTimeout(t)
    // onQuery is a fresh closure each render; only the text should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  const runServer = async (): Promise<void> => {
    setServer('Searching the server…')
    const r = await window.api.searchServer(text.trim())
    if (!r.ok) return setServer(r.error)
    setServer(r.stored ? `Found ${r.stored} more on the server` : 'Nothing more on the server')
    if (r.stored) {
      try {
        setEmails(await window.api.searchAll(text.trim(), 100))
      } catch (e) {
        setError((e as Error).message)
      }
    }
  }

  const offerServer = hasGmail && scope === 'emails' && !!text.trim()
  const scopeCount = scope === 'emails' ? emails.length : scope === 'contacts' ? contacts.length : tasks.length
  const count = scopeCount + (offerServer ? 1 : 0)
  // While the debounce runs, the results on screen still answer the old query.
  const status = searchStatus({ query: text, loading: loading || text.trim() !== resultsFor, error, count: scopeCount })

  const openAt = (i: number): void => {
    if (scope === 'emails') {
      if (i === emails.length) void runServer()
      else if (emails[i]) onOpenMessage(emails[i], emails)
    } else if (scope === 'contacts') {
      const c = contacts[i]
      if (!c) return
      setScope('emails')
      setText(`from:${c.address} OR to:${c.address}`)
    } else if (tasks[i]) onOpenTasks()
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    // Modifier chords (Ctrl+Tab, ⌘[ …) belong to the registry.
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const step = scopeStep(e)
    if (step) {
      e.preventDefault()
      const i = SCOPES.findIndex((s) => s.id === scope)
      setScope(SCOPES[(i + step + SCOPES.length) % SCOPES.length].id)
      setActive(0)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => stepIndex(i, 1, count))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => stepIndex(i, -1, count))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      openAt(active)
    }
  }

  return (
    <div className="search-page">
      <input
        ref={inputRef}
        className="search-input"
        placeholder="Search mail, people and tasks — from:, in:, label:, before:, OR, -word, &quot;phrase&quot;"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        spellCheck={false}
      />
      <div className="search-scopes" role="tablist">
        {SCOPES.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={scope === s.id}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setScope(s.id)
              setActive(0)
            }}
          >
            {s.label}
            <span className="search-scope-count">
              {s.id === 'emails' ? emails.length : s.id === 'contacts' ? contacts.length : tasks.length}
            </span>
          </button>
        ))}
      </div>
      {status && (
        <div className="search-status" role="status" data-error={!!error}>
          {status}
        </div>
      )}
      <ul className="search-results" ref={listRef}>
        {scope === 'emails' &&
          emails.map((r, i) => (
            <li key={`${r.account_id}-${r.id}`} data-active={i === active} onClick={() => openAt(i)}>
              <span className="search-from">{senderLabel(r.from_name, r.from_addr)}</span>
              <span className="search-subject">{r.subject || '(no subject)'}</span>
              <span className="search-date">{formatDate(r.date)}</span>
            </li>
          ))}
        {offerServer && (
          <li data-active={active === emails.length} onClick={() => openAt(emails.length)} className="search-server">
            {server ?? 'Search the Gmail server for older mail'}
          </li>
        )}
        {scope === 'contacts' &&
          contacts.map((c, i) => (
            <li key={c.address} data-active={i === active} onClick={() => openAt(i)}>
              <span className="search-from">{c.name ?? c.address}</span>
              <span className="search-subject">{c.name ? c.address : ''}</span>
            </li>
          ))}
        {scope === 'tasks' &&
          tasks.map((t, i) => (
            <li key={t.id} data-active={i === active} data-done={!!t.done_at} onClick={() => openAt(i)}>
              <span className="search-subject">{t.title}</span>
              {t.due_at && <span className="search-date">{formatDate(t.due_at)}</span>}
            </li>
          ))}
      </ul>
    </div>
  )
}
