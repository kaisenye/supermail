import { useEffect, useState } from 'react'
import type { UndoToast as UndoToastState } from '../store'

interface Props {
  toast: UndoToastState
  onUndo: (outboxId: number) => void
  onDismiss: () => void
}

export function UndoToast({ toast, onUndo, onDismiss }: Props) {
  const [left, setLeft] = useState(() => Math.max(0, toast.expiresAt - Date.now()))

  useEffect(() => {
    const tick = (): void => {
      const ms = Math.max(0, toast.expiresAt - Date.now())
      setLeft(ms)
      if (ms <= 0) onDismiss()
    }
    tick()
    const id = setInterval(tick, 200)
    return () => clearInterval(id)
  }, [toast.expiresAt, onDismiss])

  const secs = Math.ceil(left / 1000)

  return (
    <div className="undo-toast" role="status">
      <span>
        Sending{toast.subject ? ` “${toast.subject}”` : ''} in {secs}s
      </span>
      <button type="button" onClick={() => onUndo(toast.outboxId)}>
        Undo
      </button>
    </div>
  )
}
