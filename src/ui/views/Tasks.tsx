import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Calendar, Check, ChevronRight, Plus, Search, Trash2, X } from 'lucide-react'
import type { Priority, Task, TaskQuery } from '../../../electron/preload'
import { PriorityIcon, PriorityPicker } from './Priority'
import { RichEditor, type RichEditorHandle } from './RichEditor'
import { dueLabel, middayIn, parseQuickTask, taskSections } from '../tasksView'

const MIN_PANE = 300
const MAX_PANE = 720

type View = 'all' | 'today' | 'upcoming'
const VIEWS: { id: View; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'today', label: 'Today' },
  { id: 'upcoming', label: 'Next 7 days' }
]

/** yyyy-mm-dd for <input type="date">, in local time rather than UTC. */
function toDateInput(ms: number | null): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fromDateInput(value: string): number | null {
  if (!value) return null
  const [y, m, d] = value.split('-').map(Number)
  // Local midday: midnight would flip a day across timezones.
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime()
}

/** Typing in a field (quick add, search, title, notes) keeps its own keys. */
function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

/** Due date as a menu of the usual answers, with a real date picker behind "Pick a date". */
function DueMenu({ value, onChange }: { value: number | null; onChange: (due: number | null) => void }) {
  const [open, setOpen] = useState(false)
  const dateRef = useRef<HTMLInputElement>(null)
  const label = value ? dueLabel(value) : null
  const pick = (due: number | null): void => {
    setOpen(false)
    onChange(due)
  }
  return (
    <div className="task-due-menu">
      <button
        type="button"
        className="task-chip"
        data-tone={label?.tone}
        onClick={(e) => {
          e.currentTarget.blur()
          setOpen((v) => !v)
        }}
      >
        <Calendar size={13} strokeWidth={1.75} />
        {label ? label.text : 'Due date'}
      </button>
      {open && (
        <div className="task-menu" role="menu" onMouseLeave={() => setOpen(false)}>
          <button type="button" onClick={() => pick(middayIn(0))}>Today</button>
          <button type="button" onClick={() => pick(middayIn(1))}>Tomorrow</button>
          <button type="button" onClick={() => pick(middayIn(((8 - new Date().getDay()) % 7) || 7))}>Next week</button>
          <button type="button" onClick={() => dateRef.current?.showPicker?.()}>Pick a date…</button>
          {value && (
            <button type="button" className="task-menu-muted" onClick={() => pick(null)}>
              No date
            </button>
          )}
          <input
            ref={dateRef}
            className="task-date-hidden"
            type="date"
            tabIndex={-1}
            aria-label="Due date"
            value={toDateInput(value)}
            onChange={(e) => pick(fromDateInput(e.target.value))}
          />
        </div>
      )}
    </div>
  )
}

export function Tasks({ onChange, onClose }: { onChange?: () => void; onClose?: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [selected, setSelected] = useState<Task | null>(null)
  const [search, setSearch] = useState('')
  const [view, setView] = useState<View>('all')
  const [showDone, setShowDone] = useState(false)
  const [draft, setDraft] = useState('')
  const addRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const descRef = useRef<RichEditorHandle>(null)
  // Persisted so the pane keeps its size across restarts.
  const [paneWidth, setPaneWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('tasks.paneWidth'))
      return Number.isFinite(saved) && saved >= MIN_PANE ? saved : 380
    } catch {
      return 380
    }
  })
  const dragging = useRef(false)
  // The mouseup listener is registered once, so it needs the live width.
  const paneWidthRef = useRef(paneWidth)

  /** Recomputed per render so "today" stays correct across midnight. */
  const query = useMemo<TaskQuery>(() => {
    const endOfDay = new Date()
    endOfDay.setHours(23, 59, 59, 999)
    const dueBefore =
      view === 'today' ? endOfDay.getTime() : view === 'upcoming' ? endOfDay.getTime() + 6 * 86_400_000 : undefined
    return { includeDone: true, search: search.trim() || undefined, sort: 'manual', dueBefore }
  }, [search, view])

  const reload = useCallback(async () => {
    const list = await window.api.listTasks(query)
    setTasks(list)
    // Keep the open task in sync without closing the pane under the user.
    setSelected((cur) => (cur ? (list.find((t) => t.id === cur.id) ?? null) : null))
    onChange?.()
  }, [onChange, query])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return
      // Measured from the right edge: the pane is anchored there, so this
      // stays correct when the window resizes mid-drag.
      const next = Math.min(MAX_PANE, Math.max(MIN_PANE, window.innerWidth - e.clientX))
      paneWidthRef.current = next
      setPaneWidth(next)
    }
    const onUp = (): void => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try {
        localStorage.setItem('tasks.paneWidth', String(paneWidthRef.current))
      } catch {
        /* the width is a convenience */
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // The editor is uncontrolled, so only push HTML in when the task changes —
  // rewriting it on every keystroke would fight the caret.
  useEffect(() => {
    descRef.current?.setHtml(selected?.description ?? '')
  }, [selected?.id])

  const openTasks = tasks.filter((t) => !t.done_at)
  const doneTasks = tasks.filter((t) => t.done_at)
  const sections = useMemo(() => taskSections(openTasks), [openTasks])
  /** Rows in screen order, for j / k. */
  const visible = useMemo(
    () => [...sections.flatMap((s) => s.tasks), ...(showDone ? doneTasks : [])],
    [sections, doneTasks, showDone]
  )

  const add = useCallback(async () => {
    const parsed = parseQuickTask(draft)
    if (!parsed) return
    const res = await window.api.createTask({ ...parsed, description: null, priority: 0 })
    if (res.ok) {
      setDraft('')
      await reload()
    }
  }, [draft, reload])

  const toggleDone = useCallback(
    async (t: Task) => {
      await window.api.setTaskDone(t.id, !t.done_at)
      await reload()
    },
    [reload]
  )

  const update = useCallback(
    async (patch: Partial<Pick<Task, 'title' | 'priority' | 'due_at' | 'description'>>) => {
      if (!selected) return
      await window.api.updateTask(selected.id, patch)
      await reload()
    },
    [selected, reload]
  )

  // Tasks owns the keyboard while it is open (the app is in modal mode).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') {
        // Out of a field first, then the detail, then Tasks itself.
        if (isTyping(e.target)) return void (e.target as HTMLElement).blur()
        e.preventDefault()
        if (selected) setSelected(null)
        else onClose?.()
        return
      }
      if (isTyping(e.target)) return
      const at = selected ? visible.findIndex((t) => t.id === selected.id) : -1
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        const next = visible[Math.min(visible.length - 1, at + 1)]
        if (next) setSelected(next)
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        const next = visible[Math.max(0, at - 1)]
        if (next) setSelected(next)
      } else if (e.key === 'x' && selected) {
        e.preventDefault()
        void toggleDone(selected)
      } else if (e.key === 'n' || e.key === 'c') {
        e.preventDefault()
        addRef.current?.focus()
      } else if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, visible, toggleDone, onClose])

  const row = (t: Task) => {
    const due = t.due_at && !t.done_at ? dueLabel(t.due_at) : null
    return (
      <div
        key={t.id}
        className="task-row"
        role="button"
        tabIndex={-1}
        data-done={!!t.done_at}
        data-selected={selected?.id === t.id}
        onClick={() => setSelected(t)}
      >
        <button
          type="button"
          className="task-check"
          role="checkbox"
          aria-checked={!!t.done_at}
          aria-label={t.done_at ? 'Mark not done' : 'Mark done (x)'}
          onClick={(e) => {
            e.stopPropagation()
            void toggleDone(t)
          }}
        >
          <Check size={11} strokeWidth={3} />
        </button>
        <span className="task-title">{t.title}</span>
        {t.description && <span className="task-has-notes" aria-label="Has notes" />}
        {t.priority > 0 && !t.done_at && (
          <span className="task-pri" aria-label={`Priority ${t.priority}`}>
            <PriorityIcon value={t.priority as Priority} />
          </span>
        )}
        {due && (
          <span className="task-due" data-tone={due.tone}>
            {due.text}
          </span>
        )}
      </div>
    )
  }

  const filtered = !!search.trim() || view !== 'all'

  return (
    <div className="tasks">
      <div className="task-list">
        <div className="task-column">
          <div className="task-toolbar">
            <div className="task-views" role="tablist" aria-label="Task views">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="tab"
                  aria-selected={view === v.id}
                  onClick={(e) => {
                    e.currentTarget.blur()
                    setView(v.id)
                  }}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <label className="task-search">
              <Search size={13} strokeWidth={1.75} />
              <input
                ref={searchRef}
                value={search}
                placeholder="Search"
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && search) {
                    e.stopPropagation()
                    setSearch('')
                  }
                }}
              />
            </label>
          </div>

          {/* Quick add (Things / Linear): type, Enter. "…tomorrow" sets the date. */}
          <label className="task-add">
            <Plus size={15} strokeWidth={1.75} />
            <input
              ref={addRef}
              value={draft}
              placeholder="Add a task — end with “today”, “tomorrow” or “next week” to set a date"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void add()
                }
              }}
            />
            {draft.trim() && <kbd>↵</kbd>}
          </label>

          {!sections.length && !doneTasks.length && (
            <div className="task-empty">
              <span className="empty-title">{filtered ? 'Nothing here' : 'No tasks yet'}</span>
              <span className="empty-sub">
                {filtered ? 'Try another view or search.' : 'Add one above, or press n.'}
              </span>
            </div>
          )}

          {sections.map((s) => (
            <section key={s.label} className="task-section" data-label={s.label}>
              <h3>
                {s.label}
                <span>{s.tasks.length}</span>
              </h3>
              {s.tasks.map(row)}
            </section>
          ))}

          {doneTasks.length > 0 && (
            <section className="task-section" data-label="Done">
              <button type="button" className="task-done-toggle" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                <ChevronRight size={14} strokeWidth={1.75} />
                Done
                <span>{doneTasks.length}</span>
              </button>
              {showDone && doneTasks.map(row)}
            </section>
          )}
        </div>
      </div>

      {selected && (
        <aside className="task-detail" style={{ width: paneWidth }} key={selected.id}>
          <div
            className="task-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            onMouseDown={(e) => {
              e.preventDefault()
              dragging.current = true
              // Hold the cursor through the drag even over other elements.
              document.body.style.cursor = 'col-resize'
              document.body.style.userSelect = 'none'
            }}
            onDoubleClick={() => {
              setPaneWidth(380)
              try {
                localStorage.setItem('tasks.paneWidth', '380')
              } catch {
                /* the width is a convenience */
              }
            }}
          />
          <div className="task-detail-head">
            <button
              type="button"
              className="task-check"
              role="checkbox"
              aria-checked={!!selected.done_at}
              aria-label={selected.done_at ? 'Mark not done' : 'Mark done (x)'}
              data-done={!!selected.done_at}
              onClick={() => void toggleDone(selected)}
            >
              <Check size={11} strokeWidth={3} />
            </button>
            <textarea
              className="task-detail-title"
              rows={1}
              value={selected.title}
              onChange={(e) => setSelected({ ...selected, title: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.currentTarget.blur()
                }
              }}
              onBlur={() => {
                const title = selected.title.trim()
                if (title) void update({ title })
              }}
            />
            <button type="button" className="task-icon-btn" title="Close (Esc)" aria-label="Close" onClick={() => setSelected(null)}>
              <X size={15} strokeWidth={1.75} />
            </button>
          </div>

          <div className="task-meta">
            <PriorityPicker value={selected.priority} onChange={(p) => void update({ priority: p })} />
            <DueMenu value={selected.due_at} onChange={(due_at) => void update({ due_at })} />
            <span className="task-meta-spacer" />
            <button
              type="button"
              className="task-icon-btn task-delete"
              title="Delete task"
              aria-label="Delete task"
              onClick={async () => {
                await window.api.deleteTask(selected.id)
                setSelected(null)
                await reload()
              }}
            >
              <Trash2 size={15} strokeWidth={1.75} />
            </button>
          </div>

          <RichEditor
            ref={descRef}
            className="task-desc"
            placeholder="Notes, links, anything…"
            onSave={(html) => {
              if (html !== (selected.description ?? '')) void update({ description: html })
            }}
          />
        </aside>
      )}
    </div>
  )
}
