import { useEffect, useState } from 'react'

interface Props {
  /** Countdown target; the toast dismisses itself when it passes. */
  expiresAt: number
  /** Leading text, e.g. `Sending “Re: hi”` or `Trashed 3 messages`. */
  label: string
  onUndo: () => void
  onDismiss: () => void
}

export function UndoToast({ expiresAt, label, onUndo, onDismiss }: Props) {
  const [left, setLeft] = useState(() => Math.max(0, expiresAt - Date.now()))

  useEffect(() => {
    const tick = (): void => {
      const ms = Math.max(0, expiresAt - Date.now())
      setLeft(ms)
      if (ms <= 0) onDismiss()
    }
    tick()
    const id = setInterval(tick, 200)
    return () => clearInterval(id)
  }, [expiresAt, onDismiss])

  const secs = Math.ceil(left / 1000)

  return (
    <div className="undo-toast" role="status">
      <span>
        {label} · {secs}s
      </span>
      <button type="button" onClick={onUndo}>
        Undo
      </button>
    </div>
  )
}
