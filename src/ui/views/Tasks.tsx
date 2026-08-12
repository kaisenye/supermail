import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Calendar, Check, Link2, Search, SlidersHorizontal, Trash2 } from 'lucide-react'
import type { Priority, Task, TaskQuery } from '../../../electron/preload'
import { applyLink, captureSelection, handlePaste } from '../richText'
import { LinkPrompt } from './LinkPrompt'
import { PriorityIcon, PriorityPicker } from './Priority'
import { TaskModal } from './TaskModal'

/** Relative for anything close, absolute beyond a week. */
function dueLabel(due: number): { text: string; tone: 'overdue' | 'soon' | 'later' } {
  const now = new Date()
  const d = new Date(due)
  const startOfDay = (x: Date): number => new Date(x).setHours(0, 0, 0, 0)
  const days = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000)

  if (days < 0) return { text: days === -1 ? 'Yesterday' : `${-days}d overdue`, tone: 'overdue' }
  if (days === 0) return { text: 'Today', tone: 'soon' }
  if (days === 1) return { text: 'Tomorrow', tone: 'soon' }
  if (days < 7) {
    return { text: d.toLocaleDateString(undefined, { weekday: 'long' }), tone: 'later' }
  }
  return {
    text: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    tone: 'later'
  }
}

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

export function Tasks({
  onChange,
  creating,
  onCloseCreate
}: {
  onChange?: () => void
  creating?: boolean
  onCloseCreate?: () => void
}) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [selected, setSelected] = useState<Task | null>(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'manual' | 'due' | 'priority'>('manual')
  const [minPriority, setMinPriority] = useState(0)
  const [dueFilter, setDueFilter] = useState<'all' | 'today' | 'week' | 'overdue'>('all')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [linkPrompt, setLinkPrompt] = useState<Range | null>(null)
  const descRef = useRef<HTMLDivElement>(null)

  /** Recomputed per render so "today" stays correct across midnight. */
  const query = useMemo<TaskQuery>(() => {
    const endOfDay = new Date()
    endOfDay.setHours(23, 59, 59, 999)
    const dueBefore =
      dueFilter === 'today'
        ? endOfDay.getTime()
        : dueFilter === 'week'
          ? endOfDay.getTime() + 6 * 86_400_000
          : dueFilter === 'overdue'
            ? Date.now()
            : undefined
    return {
      includeDone: true,
      search: search.trim() || undefined,
      sort,
      minPriority: minPriority || undefined,
      dueBefore
    }
  }, [search, sort, minPriority, dueFilter])

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

  // The editor is uncontrolled, so only push HTML in when the task changes —
  // rewriting it on every keystroke would fight the caret.
  useEffect(() => {
    if (descRef.current) descRef.current.innerHTML = selected?.description ?? ''
  }, [selected?.id])

  const create = useCallback(
    async (d: { title: string; description: string | null; due_at: number | null; priority: Priority }) => {
      const res = await window.api.createTask(d)
      onCloseCreate?.()
      if (res.ok) {
        await reload()
        setSelected(res.task)
      }
    },
    [reload, onCloseCreate]
  )

  const saveDescription = useCallback(async () => {
    if (!selected || !descRef.current) return
    const html = descRef.current.innerHTML
    if (html === (selected.description ?? '')) return
    await window.api.updateTask(selected.id, { description: html })
    await reload()
  }, [selected, reload])

  const open = tasks.filter((t) => !t.done_at)
  const done = tasks.filter((t) => t.done_at)

  const row = (t: Task) => {
    const due = t.due_at ? dueLabel(t.due_at) : null
    return (
      <button
        key={t.id}
        className="task-row"
        data-done={!!t.done_at}
        data-selected={selected?.id === t.id}
        onClick={() => setSelected(t)}
      >
        <span
          className="task-check"
          role="checkbox"
          aria-checked={!!t.done_at}
          tabIndex={-1}
          onClick={async (e) => {
            e.stopPropagation()
            await window.api.setTaskDone(t.id, !t.done_at)
            await reload()
          }}
        >
          {t.done_at && <Check size={11} strokeWidth={3} />}
        </span>
        <span className="task-pri" aria-label={`Priority ${t.priority}`}>
          <PriorityIcon value={t.priority} />
        </span>
        <span className="task-title">{t.title}</span>
        {due && !t.done_at && (
          <span className="task-due" data-tone={due.tone}>
            {due.text}
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="tasks">
      <div className="task-list">
        <div className="task-toolbar">
          <label className="task-search">
            <Search size={13} strokeWidth={2} />
            <input
              value={search}
              placeholder="Search tasks…"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearch('')
              }}
            />
          </label>
          <div className="task-filter-wrap">
            <button
              className="task-filter-btn"
              data-active={sort !== 'manual' || minPriority > 0 || dueFilter !== 'all'}
              aria-haspopup="menu"
              aria-expanded={filtersOpen}
              onClick={(e) => {
                e.currentTarget.blur()
                setFiltersOpen((v) => !v)
              }}
            >
              <SlidersHorizontal size={13} strokeWidth={2} />
            </button>
            {filtersOpen && (
              <div className="task-filters" role="menu">
                <div className="task-filter-group">
                  <span className="task-filter-label">Sort</span>
                  {(['manual', 'due', 'priority'] as const).map((s2) => (
                    <button
                      key={s2}
                      className="task-filter-opt"
                      data-selected={sort === s2}
                      onClick={() => setSort(s2)}
                    >
                      {s2 === 'manual' ? 'Manual' : s2 === 'due' ? 'Due date' : 'Priority'}
                    </button>
                  ))}
                </div>
                <div className="task-filter-group">
                  <span className="task-filter-label">Priority</span>
                  {[
                    { v: 0, l: 'Any' },
                    { v: 1, l: 'Urgent' },
                    { v: 2, l: 'High and up' },
                    { v: 3, l: 'Medium and up' }
                  ].map((o) => (
                    <button
                      key={o.v}
                      className="task-filter-opt"
                      data-selected={minPriority === o.v}
                      onClick={() => setMinPriority(o.v)}
                    >
                      {o.l}
                    </button>
                  ))}
                </div>
                <div className="task-filter-group">
                  <span className="task-filter-label">Due</span>
                  {(['all', 'overdue', 'today', 'week'] as const).map((d) => (
                    <button
                      key={d}
                      className="task-filter-opt"
                      data-selected={dueFilter === d}
                      onClick={() => setDueFilter(d)}
                    >
                      {d === 'all'
                        ? 'Any'
                        : d === 'overdue'
                          ? 'Overdue'
                          : d === 'today'
                            ? 'Today'
                            : 'Next 7 days'}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {!open.length && !done.length && (
          <div className="empty">
            <span className="empty-title">
              {search || minPriority || dueFilter !== 'all' ? 'No matches' : 'No tasks'}
            </span>
            <span className="empty-sub">
              {search || minPriority || dueFilter !== 'all'
                ? 'Try a different search or filter.'
                : 'Create one to get started.'}
            </span>
          </div>
        )}

        {open.map(row)}

        {done.length > 0 && (
          <>
            <div className="task-section">Done</div>
            {done.map(row)}
          </>
        )}
      </div>

      {selected && (
        <div className="task-detail">
          <input
            className="task-detail-title"
            value={selected.title}
            onChange={(e) => setSelected({ ...selected, title: e.target.value })}
            onBlur={async () => {
              const title = selected.title.trim()
              if (!title) return
              await window.api.updateTask(selected.id, { title })
              await reload()
            }}
          />

          <div className="task-meta">
            <PriorityPicker
              value={selected.priority}
              onChange={async (p) => {
                await window.api.updateTask(selected.id, { priority: p })
                await reload()
              }}
            />
            <label className="task-date">
              <Calendar size={13} strokeWidth={2} />
              <input
                type="date"
                value={toDateInput(selected.due_at)}
                onChange={async (e) => {
                  const due = fromDateInput(e.target.value)
                  await window.api.updateTask(selected.id, { due_at: due })
                  await reload()
                }}
              />
            </label>
            <button
              className="task-link-btn"
              title="Add link"
              onClick={() => setLinkPrompt(captureSelection(descRef.current))}
            >
              <Link2 size={13} strokeWidth={2} />
            </button>
            <button
              className="task-delete"
              title="Delete task"
              onClick={async () => {
                await window.api.deleteTask(selected.id)
                setSelected(null)
                await reload()
              }}
            >
              <Trash2 size={13} strokeWidth={2} />
            </button>
          </div>

          <div
            ref={descRef}
            className="task-desc"
            contentEditable
            suppressContentEditableWarning
            data-placeholder="Notes, links, anything…"
            onPaste={(e) => handlePaste(e, descRef.current, () => void saveDescription())}
            onBlur={() => void saveDescription()}
          />
        </div>
      )}

      {creating && <TaskModal onCancel={() => onCloseCreate?.()} onCreate={create} />}

      {linkPrompt !== null && (
        <LinkPrompt
          onCancel={() => setLinkPrompt(null)}
          onSubmit={(url) => {
            applyLink(descRef.current, linkPrompt, url, () => void saveDescription())
            setLinkPrompt(null)
          }}
        />
      )}
    </div>
  )
}
