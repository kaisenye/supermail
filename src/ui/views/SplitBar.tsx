import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Inbox } from 'lucide-react'
import type { Split } from '../../../electron/preload'
import { CHIPS, type ChipId } from '../chips'

interface Props {
  /** Splits show in the Inbox only; chips show everywhere. */
  splits: Split[] | null
  activeSplit: string
  chip: ChipId | null
  onSplit: (id: string) => void
  onChip: (id: ChipId) => void
}

/**
 * Scape's filter row: a round inbox button (which split you are in, and a
 * menu to change it), then the Needs reply / Waiting / Unread / Starred pills.
 */
export function SplitBar({ splits, activeSplit, chip, onSplit, onChip }: Props) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const current = splits?.find((s) => s.id === activeSplit)
  const filtered = !!current && current.id !== 'all'

  // A click anywhere else or Esc closes the menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div className="split-bar">
      {splits && (
        <div className="split-switch" ref={wrap}>
          <button
            type="button"
            className="split-switch-btn"
            data-filtered={filtered}
            aria-haspopup="menu"
            aria-expanded={open}
            title="Split (Tab cycles)"
            onClick={(e) => {
              e.currentTarget.blur()
              setOpen((v) => !v)
            }}
          >
            <Inbox size={15} strokeWidth={1.75} />
            {filtered && (
              <>
                <span>{current.name}</span>
                <ChevronDown size={13} strokeWidth={1.75} />
              </>
            )}
          </button>
          {open && (
            <div className="split-menu" role="menu">
              {splits.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={s.id === activeSplit}
                  onClick={() => {
                    setOpen(false)
                    onSplit(s.id)
                  }}
                >
                  {s.name}
                  {s.id === activeSplit && <Check size={14} strokeWidth={2} />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="split-chips">
        {CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            data-on={chip === c.id}
            onClick={(e) => {
              e.currentTarget.blur()
              onChip(c.id)
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  )
}
