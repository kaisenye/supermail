import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

export interface PickerItem {
  id: string
  label: string
  /** Label picker: shows a check; Enter toggles instead of closing. */
  checked?: boolean
}

interface Props {
  title: string
  items: PickerItem[]
  onPick: (id: string) => void
  onClose: () => void
  emptyText?: string
}

/** A filterable list over the page, shared by Move to folder and Label. */
export function Picker({ title, items, onPick, onClose, emptyText = 'Nothing to pick' }: Props) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const shown = useMemo(
    () => items.filter((i) => i.label.toLowerCase().includes(q.trim().toLowerCase())),
    [items, q]
  )

  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => setActive(0), [q])
  // A long folder list scrolls, so keep the keyboard cursor in view.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // Keys are local to the picker, like the command palette's.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(shown.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter' && shown[active]) {
      e.preventDefault()
      onPick(shown[active].id)
    }
  }

  return (
    <div
      className="preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="picker" onKeyDown={onKey}>
        <div className="picker-title">{title}</div>
        <input
          ref={inputRef}
          className="picker-input"
          placeholder="Filter…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <ul ref={listRef} className="picker-list picker-scroll">
          {shown.length === 0 && <li className="picker-hint">{emptyText}</li>}
          {shown.map((it, i) => (
            <li key={it.id}>
              <button type="button" data-active={i === active} onClick={() => onPick(it.id)}>
                <span>{it.label}</span>
                {it.checked !== undefined && (
                  <span className="picker-meta">{it.checked ? '✓' : ''}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
