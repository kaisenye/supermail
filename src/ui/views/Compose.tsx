import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import { Link2, List, ListOrdered, Paperclip, X } from 'lucide-react'
import { useCommandChord } from '../hooks/useCommandChord'
import { applyLink, captureSelection, cleanPastedHtml, handlePaste } from '../richText'
import { LinkPrompt } from './LinkPrompt'
import { RemindPicker } from './RemindPicker'
import { RecipientField } from './RecipientField'
import { useStore, type ComposeState } from '../store'

interface Props {
  compose: ComposeState
  onClose: () => void
  onSent: (outboxId: number, subject: string, undoMs: number, immediate: boolean) => void
}

const SCHEDULE_OPTS = [
  { id: 'now', label: 'Send now', offsetMs: 0 },
  { id: '1h', label: 'In 1 hour', offsetMs: 3_600_000 },
  { id: 'tomorrow9', label: 'Tomorrow 9am', offsetMs: -1 },
  { id: 'monday9', label: 'Monday 9am', offsetMs: -2 }
] as const

// B/I/U stay as letterforms — they read faster than glyphs for text styling.
const TOOLS = [
  { cmd: 'bold', label: 'B', title: 'Bold ⌘B' },
  { cmd: 'italic', label: 'I', title: 'Italic ⌘I' },
  { cmd: 'underline', label: 'U', title: 'Underline ⌘U' },
  { cmd: 'insertUnorderedList', icon: List, title: 'Bulleted list' },
  { cmd: 'insertOrderedList', icon: ListOrdered, title: 'Numbered list' }
] as const

/** null = now: main adds the undo window, whose length is a setting it owns. */
function scheduleAt(id: string): number | null {
  const now = new Date()
  if (id === 'now') return null
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
  const [reminding, setReminding] = useState(false)
  const [linking, setLinking] = useState(false)
  const editorRef = useRef<HTMLDivElement>(null)
  const sendingRef = useRef(false)

  const title = useMemo(() => {
    if (compose.mode === 'reply') return 'Reply'
    if (compose.mode === 'forward') return 'Forward'
    if (compose.mode === 'replyAll') return 'Reply all'
    return 'New message'
  }, [compose.mode])

  // Seed once from store; after that the DOM owns the text, so re-syncing
  // innerHTML on every keystroke would fight the caret.
  useEffect(() => {
    const el = editorRef.current
    if (el && el.innerHTML !== compose.body) el.innerHTML = compose.body
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compose.draftId])

  // execCommand is deprecated with no shipped replacement; for a small
  // contenteditable toolbar it is still the pragmatic choice over a rich-text lib.
  const exec = useCallback((cmd: string, value?: string) => {
    editorRef.current?.focus()
    document.execCommand(cmd, false, value)
    const el = editorRef.current
    if (el) updateCompose({ body: el.innerHTML })
  }, [updateCompose])

  // Electron has no window.prompt(), and focusing the inline input clears the
  // selection — so capture the range before showing it.
  const pendingRange = useRef<Range | null>(null)

  const onLink = useCallback(() => {
    pendingRange.current = captureSelection(editorRef.current)
    setLinking(true)
  }, [])

  const submitLink = useCallback(
    (url: string) => {
      setLinking(false)
      applyLink(editorRef.current, pendingRange.current, url, (body) =>
        updateCompose({ body })
      )
      pendingRange.current = null
    },
    [updateCompose]
  )

  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLDivElement>) => {
      handlePaste(e, editorRef.current, (body) => updateCompose({ body }))
    },
    [updateCompose]
  )

  const onPickFiles = useCallback(async () => {
    const picked = await window.api.pickAttachments()
    if (picked.length) {
      updateCompose({ attachments: [...compose.attachments, ...picked] })
    }
  }, [compose.attachments, updateCompose])

  const persistAndQueue = useCallback(
    async (sendAt: number | null) => {
      if (!compose.to.trim()) {
        setError('Add at least one recipient')
        return
      }
      // `sending` is state, so two ⌘↵ in one tick both see false and both
      // enqueue. The ref flips synchronously and actually closes that window.
      if (sendingRef.current) return
      sendingRef.current = true
      setSending(true)
      setError(null)
      try {
        // Sanitise on send, not just on paste: contenteditable emits raw
        // newlines that HTML would collapse, and this is the last point where
        // outbound markup can still be corrected.
        const body = cleanPastedHtml(editorRef.current?.innerHTML ?? compose.body)
        const saved = await window.api.saveDraft({
          draftId: compose.draftId,
          to: compose.to,
          cc: compose.cc,
          bcc: compose.bcc,
          subject: compose.subject,
          body,
          inReplyTo: compose.inReplyTo,
          references: compose.references,
          attachments: compose.attachments
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
          body,
          inReplyTo: compose.inReplyTo,
          references: compose.references,
          attachments: compose.attachments,
          sendAt,
          remindAt: compose.remindAt
        })
        if (!queued.ok) {
          setError(queued.error)
          return
        }
        onSent(
          queued.outboxId,
          compose.subject || '(no subject)',
          Math.max(0, queued.sendAt - Date.now()),
          sendAt === null
        )
        onClose()
      } finally {
        sendingRef.current = false
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
      },
      // Declared in commands.ts as compose.remind.
      { key: 'h', shift: true, handler: () => setReminding(true) }
    ],
    [persistAndQueue, sending]
  )
  useCommandChord(chords)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !showSchedule && !reminding) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, showSchedule, reminding])

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
      {compose.remindAt && (
        <div className="compose-remind">
          Remind me if no reply ·{' '}
          {new Date(compose.remindAt).toLocaleString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
          })}
          <button
            type="button"
            aria-label="Remove reminder"
            onClick={() => updateCompose({ remindAt: null })}
          >
            ×
          </button>
        </div>
      )}
      {/* Always "if no reply" (main sets it on send), so the checkbox only matters for h. */}
      {reminding && (
        <RemindPicker
          title="Remind me if no reply"
          defaultIfNoReply
          onPick={(at) => {
            setReminding(false)
            updateCompose({ remindAt: at })
          }}
          onClose={() => setReminding(false)}
        />
      )}
      {error && (
        <div className="compose-error" role="alert">
          {error}
        </div>
      )}
      <div className="compose-fields">
        <RecipientField
          label="To"
          value={compose.to}
          onChange={(to) => updateCompose({ to })}
          autoFocus
        />
        <RecipientField
          label="Cc"
          value={compose.cc}
          onChange={(cc) => updateCompose({ cc })}
        />
        <RecipientField
          label="Bcc"
          value={compose.bcc}
          onChange={(bcc) => updateCompose({ bcc })}
        />
        <label className="compose-field">
          <span>Subject</span>
          <input
            value={compose.subject}
            onChange={(e) => updateCompose({ subject: e.target.value })}
          />
        </label>
      </div>
      <div className="compose-toolbar">
        {TOOLS.map((t) => {
          const Icon = 'icon' in t ? t.icon : null
          return (
            <button
              key={t.cmd}
              type="button"
              className="compose-tool"
              title={t.title}
              aria-label={t.title}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => exec(t.cmd)}
            >
              {Icon ? <Icon size={15} strokeWidth={2} /> : 'label' in t && t.label}
            </button>
          )
        })}
        <button
          type="button"
          className="compose-tool"
          title="Insert link"
          aria-label="Insert link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onLink}
        >
          <Link2 size={15} strokeWidth={2} />
        </button>
        <span className="compose-toolbar-sep" />
        <button
          type="button"
          className="compose-tool"
          title="Attach files"
          aria-label="Attach files"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void onPickFiles()}
        >
          <Paperclip size={15} strokeWidth={2} />
        </button>
      </div>
      {linking && (
        <LinkPrompt
          onSubmit={submitLink}
          onCancel={() => {
            setLinking(false)
            pendingRange.current = null
          }}
        />
      )}
      <div
        ref={editorRef}
        className="compose-body"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Message body"
        data-empty={!compose.body}
        data-placeholder="Write your message…"
        onInput={(e) => updateCompose({ body: e.currentTarget.innerHTML })}
        onPaste={onPaste}
      />
      {compose.attachments.length > 0 && (
        <div className="compose-attachments">
          {compose.attachments.map((a) => (
            <span key={a.path} className="compose-chip">
              {a.filename}
              <button
                type="button"
                aria-label={`Remove ${a.filename}`}
                onClick={() =>
                  updateCompose({
                    attachments: compose.attachments.filter((x) => x.path !== a.path)
                  })
                }
              >
                <X size={12} strokeWidth={2.5} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
