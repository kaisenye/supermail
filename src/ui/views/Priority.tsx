import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import type { Priority } from '../../../electron/preload'

export const PRIORITIES: { value: Priority; label: string }[] = [
  { value: 0, label: 'No priority' },
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' }
]

/**
 * Linear's priority glyphs: three ascending bars with the inactive ones dimmed,
 * so urgency reads at a glance without colour carrying the whole signal.
 * Urgent is the exception — a filled square, because it should not look like
 * "more of the same".
 */
export function PriorityIcon({ value, size = 13 }: { value: Priority; size?: number }) {
  if (value === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" className="pri-icon" data-p="0">
        <rect x="1" y="6.25" width="3" height="1.5" rx="0.75" />
        <rect x="5.5" y="6.25" width="3" height="1.5" rx="0.75" />
        <rect x="10" y="6.25" width="3" height="1.5" rx="0.75" />
      </svg>
    )
  }
  if (value === 1) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" className="pri-icon" data-p="1">
        <rect x="1" y="1" width="12" height="12" rx="2.5" />
        <rect x="6.25" y="3.5" width="1.5" height="4.5" rx="0.75" className="pri-mark" />
        <rect x="6.25" y="9.25" width="1.5" height="1.5" rx="0.75" className="pri-mark" />
      </svg>
    )
  }
  // 2 High = 3 bars, 3 Medium = 2, 4 Low = 1. Remaining bars stay dim.
  const filled = value === 2 ? 3 : value === 3 ? 2 : 1
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className="pri-icon" data-p={value}>
      <rect x="1" y="8.5" width="3" height="4.5" rx="1" data-on={filled >= 1} />
      <rect x="5.5" y="5.5" width="3" height="7.5" rx="1" data-on={filled >= 2} />
      <rect x="10" y="2.5" width="3" height="10.5" rx="1" data-on={filled >= 3} />
    </svg>
  )
}

interface Props {
  value: Priority
  onChange: (p: Priority) => void
  /** Compact form for list rows: icon only, no label. */
  compact?: boolean
}

export function PriorityPicker({ value, onChange, compact }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = PRIORITIES.find((p) => p.value === value) ?? PRIORITIES[0]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        return
      }
      // 0–4 pick directly, as in Linear.
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 0 && n <= 4) {
        e.preventDefault()
        onChange(n as Priority)
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onChange])

  return (
    <div className="pri-wrap" ref={ref}>
      <button
        className="pri-trigger"
        data-compact={!!compact}
        title={`Priority: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          e.currentTarget.blur()
          setOpen((v) => !v)
        }}
      >
        <PriorityIcon value={value} />
        {!compact && <span>{current.label}</span>}
      </button>

      {open && (
        <div className="pri-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <div className="pri-menu-head">Change priority to…</div>
          {PRIORITIES.map((p) => (
            <button
              key={p.value}
              role="menuitem"
              className="pri-item"
              data-selected={p.value === value}
              onClick={() => {
                onChange(p.value)
                setOpen(false)
              }}
            >
              <PriorityIcon value={p.value} />
              <span className="pri-item-label">{p.label}</span>
              {p.value === value && <Check size={12} strokeWidth={2.5} />}
              <span className="pri-item-key">{p.value}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
