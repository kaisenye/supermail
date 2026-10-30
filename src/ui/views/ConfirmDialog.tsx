import { useEffect, useRef } from 'react'

interface Props {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

/** Enter confirms, Esc cancels. Used wherever an action reaches outside the mailbox. */
export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel }: Props) {
  const okRef = useRef<HTMLButtonElement>(null)
  useEffect(() => okRef.current?.focus(), [])
  return (
    <div
      className="preview-backdrop"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <div className="picker">
        <div className="picker-title">{title}</div>
        <p className="settings-note">{body}</p>
        <div className="settings-themes">
          <button ref={okRef} type="button" data-on="true" onClick={onConfirm}>
            {confirmLabel}
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
