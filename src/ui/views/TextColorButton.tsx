import { useEffect, useRef, useState } from 'react'
import { Baseline } from 'lucide-react'

/** Mid-tone, so each reads on a white inbox and on our dark editor alike. */
export const TEXT_COLORS = [
  { name: 'Gray', value: '#6b7280' },
  { name: 'Red', value: '#dc2626' },
  { name: 'Orange', value: '#ea580c' },
  { name: 'Green', value: '#16a34a' },
  { name: 'Blue', value: '#2563eb' },
  { name: 'Purple', value: '#7c3aed' }
] as const

interface Props {
  /** null = back to the default text color. */
  onPick: (color: string | null) => void
  /** Which way the swatches open: up from compose's footer, down from a toolbar. */
  placement?: 'up' | 'down'
  /** Class for the trigger, so it matches the toolbar it sits in. */
  className?: string
}

/**
 * Text color for the compose body and the signature. Every control keeps the
 * mouse from taking focus, so the editor's selection survives until a swatch
 * applies to it. Esc and a click outside close it; Esc stops there, so it
 * never reaches compose's own Esc (discard).
 */
export function TextColorButton({ onPick, placement = 'up', className }: Props) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
    const onDown = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const pick = (color: string | null): void => {
    setOpen(false)
    onPick(color)
  }

  return (
    <span className="text-color" ref={wrap}>
      <button
        type="button"
        className={className}
        title="Text color"
        aria-label="Text color"
        aria-expanded={open}
        data-on={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        <Baseline size={15} strokeWidth={1.75} />
      </button>
      {open && (
        <span className="text-color-menu" data-placement={placement} role="menu" aria-label="Text color">
          <button
            type="button"
            role="menuitem"
            className="text-color-swatch is-default"
            title="Default"
            aria-label="Default color"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(null)}
          />
          {TEXT_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              role="menuitem"
              className="text-color-swatch"
              title={c.name}
              aria-label={c.name}
              style={{ '--swatch': c.value } as React.CSSProperties}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(c.value)}
            />
          ))}
        </span>
      )}
    </span>
  )
}
