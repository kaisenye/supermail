import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { parseWhen, PRESETS } from '../when'

interface Props {
  title?: string
  /** Compose turns this on: a reminder on your own mail is about the reply. */
  defaultIfNoReply?: boolean
  /** The checkbox under the presets; send later hides it. */
  showCheck?: boolean
  checkLabel?: string
  onPick: (at: number, ifNoReply: boolean) => void
  /** Shown when the target already has a reminder. */
  onClear?: () => void
  onClose: () => void
}

const fmt = (d: Date): string =>
  d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

export function RemindPicker({
  title = 'Remind me',
  defaultIfNoReply = false,
  showCheck = true,
  checkLabel = 'Only if nobody replies',
  onPick,
  onClear,
  onClose
}: Props) {
  const [text, setText] = useState('')
  const [active, setActive] = useState(0)
  const [ifNoReply, setIfNoReply] = useState(defaultIfNoReply)
  const inputRef = useRef<HTMLInputElement>(null)
  const parsed = useMemo(() => parseWhen(text, new Date()), [text])

  useEffect(() => inputRef.current?.focus(), [])

  const submit = (at: Date | null): void => {
    if (at && at.getTime() > Date.now()) onPick(at.getTime(), ifNoReply)
  }

  // Keys are local to the picker, like the command palette's.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(PRESETS.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      submit(text.trim() ? parsed : PRESETS[active].at(new Date()))
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
          placeholder="tomorrow 9am, fri, in 3 days…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="picker-hint">
          {text.trim() ? (parsed ? fmt(parsed) : 'Not a time I understand') : '↑↓ to choose, ↵ to set'}
        </div>
        <ul className="picker-list">
          {PRESETS.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                data-active={!text.trim() && i === active}
                onClick={() => submit(p.at(new Date()))}
              >
                <span>{p.label}</span>
                <span className="picker-meta">{fmt(p.at(new Date()))}</span>
              </button>
            </li>
          ))}
        </ul>
        {showCheck && (
          <label className="picker-check">
            <input
              type="checkbox"
              checked={ifNoReply}
              onChange={(e) => setIfNoReply(e.target.checked)}
            />
            {checkLabel}
          </label>
        )}
        {onClear && (
          <button type="button" className="picker-clear" onClick={onClear}>
            Remove reminder
          </button>
        )}
      </div>
    </div>
  )
}
