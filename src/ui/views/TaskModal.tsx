import { useEffect, useRef, useState } from 'react'
import { Calendar, X } from 'lucide-react'
import type { Priority } from '../../../electron/preload'
import { PriorityPicker } from './Priority'
import { RichEditor, type RichEditorHandle } from './RichEditor'

export interface NewTaskDraft {
  title: string
  description: string | null
  due_at: number | null
  priority: Priority
}

function fromDateInput(value: string): number | null {
  if (!value) return null
  const [y, m, d] = value.split('-').map(Number)
  // Local midday: midnight would flip a day across timezones.
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime()
}

interface Props {
  onCancel: () => void
  onCreate: (draft: NewTaskDraft) => void
}

export function TaskModal({ onCancel, onCreate }: Props) {
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [priority, setPriority] = useState<Priority>(0)
  const titleRef = useRef<HTMLInputElement>(null)
  const descRef = useRef<RichEditorHandle>(null)

  useEffect(() => {
    titleRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = (): void => {
    const t = title.trim()
    if (!t) return
    onCreate({
      title: t,
      description: descRef.current?.getHtml().trim() || null,
      due_at: fromDateInput(due),
      priority
    })
  }

  return (
    <div className="tm-backdrop" onClick={onCancel}>
      <div
        className="tm-panel"
        role="dialog"
        aria-modal="true"
        aria-label="New task"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="tm-head">
          <span className="tm-eyebrow">New task</span>
          <button className="tm-close" onClick={onCancel} aria-label="Close">
            <X size={13} strokeWidth={2} />
          </button>
        </header>

        <input
          ref={titleRef}
          className="tm-title"
          value={title}
          placeholder="Task title"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            // Enter from the title submits; the description takes its own.
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />

        <RichEditor
          ref={descRef}
          className="tm-desc"
          placeholder="Add description…"
          onSave={() => {}}
        />

        <div className="tm-controls">
          <PriorityPicker value={priority} onChange={setPriority} />
          <label className="tm-date">
            <Calendar size={13} strokeWidth={2} />
            <input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              aria-label="Due date"
            />
          </label>
        </div>

        <footer className="tm-foot">
          <span className="tm-hint">
            <kbd>↵</kbd> to create · <kbd>Esc</kbd> to cancel
          </span>
          <button className="tm-create" disabled={!title.trim()} onClick={submit}>
            Create task
          </button>
        </footer>
      </div>
    </div>
  )
}
