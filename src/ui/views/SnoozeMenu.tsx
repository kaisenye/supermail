import { useEffect, useRef, useState } from 'react'
import { Clock } from 'lucide-react'

/**
 * Snooze presets. Times are computed at click, not at render, so a menu left
 * open across midnight cannot schedule into the past.
 */
interface Preset {
  label: string
  at: () => Date
  hint: (d: Date) => string
}

function atHour(d: Date, hour: number): Date {
  const out = new Date(d)
  out.setHours(hour, 0, 0, 0)
  return out
}

function timeHint(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function dayHint(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + timeHint(d)
}

const PRESETS: Preset[] = [
  {
    label: 'Later today',
    at: () => new Date(Date.now() + 3 * 60 * 60 * 1000),
    hint: timeHint
  },
  {
    label: 'Tomorrow',
    at: () => {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      return atHour(d, 8)
    },
    hint: dayHint
  },
  {
    label: 'This weekend',
    at: () => {
      const d = new Date()
      // 6 = Saturday. Always lands on the next one, never today.
      const delta = (6 - d.getDay() + 7) % 7 || 7
      d.setDate(d.getDate() + delta)
      return atHour(d, 8)
    },
    hint: dayHint
  },
  {
    label: 'Next week',
    at: () => {
      const d = new Date()
      // 1 = Monday.
      const delta = (1 - d.getDay() + 7) % 7 || 7
      d.setDate(d.getDate() + delta)
      return atHour(d, 8)
    },
    hint: dayHint
  }
]

export function SnoozeMenu({ onSnooze }: { onSnooze: (wakeAt: number) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="snooze-wrap" ref={ref}>
      <button
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.currentTarget.blur()
          setOpen((v) => !v)
        }}
      >
        Snooze
      </button>
      {open && (
        <div className="snooze-menu" role="menu">
          {PRESETS.map((p) => {
            const when = p.at()
            return (
              <button
                key={p.label}
                role="menuitem"
                className="snooze-item"
                onClick={() => {
                  setOpen(false)
                  // Recompute: the menu may have sat open for a while.
                  onSnooze(p.at().getTime())
                }}
              >
                <Clock size={12} strokeWidth={2} />
                <span className="snooze-label">{p.label}</span>
                <span className="snooze-hint">{p.hint(when)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
