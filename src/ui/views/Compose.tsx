import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCommandChord } from '../hooks/useCommandChord'
import { useStore, type ComposeState } from '../store'

interface Props {
  compose: ComposeState
  onClose: () => void
  onSent: (outboxId: number, subject: string, undoMs: number) => void
}

const SCHEDULE_OPTS = [
  { id: 'now', label: 'Send now', offsetMs: 10_000 },
  { id: '1h', label: 'In 1 hour', offsetMs: 3_600_000 },
  { id: 'tomorrow9', label: 'Tomorrow 9am', offsetMs: -1 },
  { id: 'monday9', label: 'Monday 9am', offsetMs: -2 }
] as const

function scheduleAt(id: string): number {
  const now = new Date()
  if (id === 'now') return Date.now() + 10_000
  if (id === '1h') return Date.now() + 3_600_000
  if (id === 'tomorrow9') {
    const d = new Date(now)
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d.getTime()
  }
  // next Monday 9am
  const d = new Date(now)
  const day = d.getDay()
  const add = day === 1 ? 7 : (8 - day) % 7 || 7
  d.setDate(d.getDate() + add)
  d.setHours(9, 0, 0, 0)
  return d.getTime()
}

export function Compose({ compose, onClose, onSent }: Props) {
  const updateCompose = useStore((s) => s.updateCompose)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showSchedule, setShowSchedule] = useState(false)

  const title = useMemo(() => {
    if (compose.mode === 'reply') return 'Reply'
    if (compose.mode === 'replyAll') return 'Reply all'
    return 'New message'
  }, [compose.mode])

  const persistAndQueue = useCallback(
    async (sendAt: number) => {
      if (!compose.to.trim()) {
        setError('Add at least one recipient')
        return
      }
      setSending(true)
      setError(null)
      try {
        const saved = await window.api.saveDraft({
          draftId: compose.draftId,
          to: compose.to,
          cc: compose.cc,
          bcc: compose.bcc,
          subject: compose.subject,
          body: compose.body,
          inReplyTo: compose.inReplyTo,
          references: compose.references
        })
        if (!saved.ok) {
          setError(saved.error)
          return
        }
        updateCompose({ draftId: saved.draftId })
        const queued = await window.api.queueSend({
          draftId: saved.draftId,
          to: compose.to,
          cc: compose.cc,
          bcc: compose.bcc,
          subject: compose.subject,
          body: compose.body,
          inReplyTo: compose.inReplyTo,
          references: compose.references,
          sendAt
        })
        if (!queued.ok) {
          setError(queued.error)
          return
        }
        const undoMs = Math.max(0, sendAt - Date.now())
        onSent(queued.outboxId, compose.subject || '(no subject)', undoMs)
        onClose()
      } finally {
        setSending(false)
      }
    },
    [compose, onClose, onSent, updateCompose]
  )

  const chords = useMemo(
    () => [
      {
        key: 'Enter',
        handler: () => {
          if (!sending) void persistAndQueue(scheduleAt('now'))
        }
      }
    ],
    [persistAndQueue, sending]
  )
  useCommandChord(chords)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !showSchedule) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, showSchedule])

  return (
    <div className="compose">
      <header className="compose-header">
        <h1 className="compose-title">{title}</h1>
        <div className="compose-actions">
          <button type="button" className="compose-btn" onClick={onClose} disabled={sending}>
            Discard
          </button>
          <div className="compose-schedule-wrap">
            <button
              type="button"
              className="compose-btn"
              onClick={() => setShowSchedule((v) => !v)}
              disabled={sending}
            >
              Later
            </button>
            {showSchedule && (
              <div className="compose-schedule-menu">
                {SCHEDULE_OPTS.filter((o) => o.id !== 'now').map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => {
                      setShowSchedule(false)
                      void persistAndQueue(scheduleAt(o.id))
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="compose-btn compose-btn-primary"
            disabled={sending}
            onClick={() => void persistAndQueue(scheduleAt('now'))}
          >
            {sending ? 'Queuing…' : 'Send'}
            <span className="compose-hint">⌘↵</span>
          </button>
        </div>
      </header>
      {error && (
        <div className="compose-error" role="alert">
          {error}
        </div>
      )}
      <div className="compose-fields">
        <label className="compose-field">
          <span>To</span>
          <input
            value={compose.to}
            onChange={(e) => updateCompose({ to: e.target.value })}
            autoFocus
          />
        </label>
        <label className="compose-field">
          <span>Cc</span>
          <input
            value={compose.cc}
            onChange={(e) => updateCompose({ cc: e.target.value })}
          />
        </label>
        <label className="compose-field">
          <span>Subject</span>
          <input
            value={compose.subject}
            onChange={(e) => updateCompose({ subject: e.target.value })}
          />
        </label>
      </div>
      <textarea
        className="compose-body"
        value={compose.body}
        onChange={(e) => updateCompose({ body: e.target.value })}
        placeholder="Write your message…"
      />
    </div>
  )
}
