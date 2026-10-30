import { useEffect, useRef, useState } from 'react'

interface Props {
  folderId: number
  onDone: (opts: { olderThanDays: number; keepUnread: boolean; keepStarred: boolean }) => void
  onCancel: () => void
}

/** Get me to zero: bulk Done with a live count, so nothing happens by surprise. */
export function ZeroModal({ folderId, onDone, onCancel }: Props) {
  const [days, setDays] = useState(7)
  const [keepUnread, setKeepUnread] = useState(true)
  const [keepStarred, setKeepStarred] = useState(true)
  const [count, setCount] = useState<number | null>(null)
  const opts = { olderThanDays: days, keepUnread, keepStarred }
  // Opened from Cmd+K, focus would otherwise land on <body>, where Escape and
  // Enter reach nothing (the global Escape binding is off in modal mode).
  const daysRef = useRef<HTMLInputElement>(null)
  useEffect(() => daysRef.current?.focus(), [])

  useEffect(() => {
    void window.api
      .zeroCount(folderId, { olderThanDays: days, keepUnread, keepStarred })
      .then((r) => setCount(r.count))
  }, [folderId, days, keepUnread, keepStarred])

  return (
    <div
      className="preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Get me to zero"
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
      <form
        className="picker"
        onSubmit={(e) => {
          e.preventDefault()
          if (count) onDone(opts)
        }}
      >
        <div className="picker-title">Get me to zero</div>
        <label className="picker-check">
          Mark Done everything older than
          <input
            ref={daysRef}
            type="number"
            min={0}
            value={days}
            onChange={(e) => setDays(Math.max(0, Number(e.target.value) || 0))}
          />
          days
        </label>
        <label className="picker-check">
          <input
            type="checkbox"
            checked={keepUnread}
            onChange={(e) => setKeepUnread(e.target.checked)}
          />{' '}
          Keep unread
        </label>
        <label className="picker-check">
          <input
            type="checkbox"
            checked={keepStarred}
            onChange={(e) => setKeepStarred(e.target.checked)}
          />{' '}
          Keep starred
        </label>
        <p className="settings-note">
          {count === null
            ? '…'
            : `${count} conversation${count === 1 ? '' : 's'} will be marked Done. You can undo.`}
        </p>
        <div className="settings-themes">
          <button type="submit" data-on="true" disabled={!count}>
            Mark Done
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
