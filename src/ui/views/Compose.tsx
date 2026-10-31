import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { ArrowLeft, ArrowUp, Bold, ChevronDown, Clock, Ellipsis, Italic, Link2, List, ListOrdered, Paperclip, SendHorizontal, Sparkles, Trash2, Underline, X } from 'lucide-react'
import { useCommandChord } from '../hooks/useCommandChord'
import { useActiveFormats } from '../hooks/useActiveFormats'
import { aiTargetRange, aiWriteRange, applyLink, captureCaret, captureSelection, cleanPastedHtml, handlePaste } from '../richText'
import { latestOnly, rangeText, textToHtml } from '../aiText'
import { expandSnippet, shortcutBeforeCaret, snippetHtml, snippetVars } from '../snippetVars'
import { AiWriteMenu } from './AiWriteMenu'
import { LinkPrompt } from './LinkPrompt'
import { Picker } from './Picker'
import { RemindPicker } from './RemindPicker'
import { RecipientField } from './RecipientField'
import { instantIntro } from '../intro'
import { useStore, type ComposeState } from '../store'
import { composeDirty, type ComposeSnapshot } from '../composePlace'
import type { Snippet, WriteAction } from '../../../electron/preload'

interface Props {
  compose: ComposeState
  /** You, for {my_name} / {my_email}. */
  me: { name: string | null; email: string | null }
  /** Settings default for "Cancel if someone replies first" on a scheduled reply. */
  cancelOnReplyDefault: boolean
  onClose: () => void
  /**
   * A reply or forward at the end of the open thread (Scape): just the card,
   * no page bar or heading.
   */
  inline?: boolean
  /** `doneId` is the replied-to message when the send was ⌘⇧↵ (Send + Done). */
  onSent: (
    outboxId: number,
    subject: string,
    undoMs: number,
    immediate: boolean,
    doneId: number | null
  ) => void | Promise<void>
}

// B/I/U stay as letterforms — they read faster than glyphs for text styling.
const TOOLS = [
  { cmd: 'bold', icon: Bold, title: 'Bold ⌘B' },
  { cmd: 'italic', icon: Italic, title: 'Italic ⌘I' },
  { cmd: 'underline', icon: Underline, title: 'Underline ⌘U' },
  { cmd: 'insertUnorderedList', icon: List, title: 'Bulleted list' },
  { cmd: 'insertOrderedList', icon: ListOrdered, title: 'Numbered list' }
] as const

export function Compose({ compose, me, cancelOnReplyDefault, onClose, onSent, inline = false }: Props) {
  const updateCompose = useStore((s) => s.updateCompose)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [laterOpen, setLaterOpen] = useState(false)
  const [reminding, setReminding] = useState(false)
  const [linking, setLinking] = useState(false)
  /** Cc and Bcc rows stay folded behind "Cc / Bcc" until used (Scape). */
  const [showCc, setShowCc] = useState(() => !!(compose.cc || compose.bcc))
  /** A reply's quote or a forward's message folds behind "…" (Scape); it is still sent. */
  const [showQuote, setShowQuote] = useState(false)
  const editorRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const sendingRef = useRef(false)

  const title = useMemo(() => {
    if (compose.mode === 'reply') return 'Reply'
    if (compose.mode === 'forward') return 'Forward'
    if (compose.mode === 'replyAll') return 'Reply all'
    return 'New message'
  }, [compose.mode])

  // Seed once from store; after that the DOM owns the text, so re-syncing
  // innerHTML on every keystroke would fight the caret.
  /** What the message looked like when it opened, so Esc knows whether there is a draft to keep. */
  const opened = useRef<ComposeSnapshot | null>(null)
  useEffect(() => {
    const el = editorRef.current
    if (el && el.innerHTML !== compose.body) el.innerHTML = compose.body
    // Read back from the editor: the browser normalises HTML it is given, so
    // the store's string would never compare equal to it.
    if (!opened.current) {
      opened.current = {
        to: compose.to,
        cc: compose.cc,
        bcc: compose.bcc,
        subject: compose.subject,
        body: el?.innerHTML ?? compose.body,
        attachments: compose.attachments.length
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compose.draftId])

  /**
   * Esc and ← close but keep the message as a draft when it has changed;
   * only the trash button discards. Nothing autosaves, so closing used to
   * lose a half-written reply with no way back.
   */
  const closeKeepingDraft = useCallback(async () => {
    const html = editorRef.current?.innerHTML ?? compose.body
    const now: ComposeSnapshot = {
      to: compose.to,
      cc: compose.cc,
      bcc: compose.bcc,
      subject: compose.subject,
      body: html,
      attachments: compose.attachments.length
    }
    if (opened.current && composeDirty(opened.current, now)) {
      const saved = await window.api.saveDraft({
        draftId: compose.draftId,
        to: compose.to,
        cc: compose.cc,
        bcc: compose.bcc,
        subject: compose.subject,
        body: cleanPastedHtml(html, { keepMarkers: true }),
        inReplyTo: compose.inReplyTo,
        references: compose.references,
        attachments: compose.attachments,
        accountId: compose.accountId
      })
      // Keep the window open rather than lose the text if the save failed.
      if (!saved.ok) return setError(saved.error)
    }
    onClose()
  }, [compose, onClose])

  // execCommand is deprecated with no shipped replacement; for a small
  // contenteditable toolbar it is still the pragmatic choice over a rich-text lib.
  /** Formats on at the caret, so the toolbar shows B / I / U / lists as pressed. */
  const [activeFormats, refreshFormats] = useActiveFormats(editorRef)

  const exec = useCallback((cmd: string, value?: string) => {
    editorRef.current?.focus()
    document.execCommand(cmd, false, value)
    const el = editorRef.current
    if (el) updateCompose({ body: el.innerHTML })
    // Toggling bold on a collapsed caret changes no selection, so no
    // selectionchange fires: read the state now.
    refreshFormats()
  }, [updateCompose, refreshFormats])

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

  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [pickingSnippet, setPickingSnippet] = useState(false)
  const caretRef = useRef<Range | null>(null)
  useEffect(() => {
    void window.api.listSnippets().then(setSnippets)
  }, [])

  const [aiOpen, setAiOpen] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiScope, setAiScope] = useState<'selection' | 'message'>('message')
  const aiRange = useRef<Range | null>(null)
  const [aiFocus, setAiFocus] = useState(0)
  // Closing the menu or Compose cancels the in-flight request, so a late reply
  // never rewrites a range the user walked away from (or another compose).
  const aiReq = useRef(latestOnly())
  useEffect(() => () => aiReq.current.cancel(), [])

  // Captured before the menu's input takes focus, which clears the selection.
  // The chord and the toolbar button (mousedown prevented) both run before
  // focus moves, so captureSelection still sees what the user picked.
  const openAi = useCallback(() => {
    // ⌘J again must not re-capture the range; it only brings focus back to the menu.
    if (aiOpen) return setAiFocus((n) => n + 1)
    const el = editorRef.current
    const picked = captureSelection(el)
    aiRange.current = picked ?? aiTargetRange(el)
    setAiScope(picked ? 'selection' : 'message')
    setAiError(null)
    setAiOpen(true)
  }, [aiOpen])

  const runAi = useCallback(
    async (action: WriteAction, instruction?: string) => {
      const el = editorRef.current
      const range = aiRange.current
      if (!el || !range) return
      const current = aiReq.current.start()
      setAiBusy(true)
      setAiError(null)
      try {
        const r = await window.api.aiWrite({
          action,
          text: rangeText(range),
          instruction,
          scope: aiScope,
          sourceMessageId: compose.sourceMessageId
        })
        if (!current() || !el.isConnected) return
        if (!r.ok) return setAiError(r.error)
        el.focus()
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(aiWriteRange(el, range))
        // insertHTML keeps the change on the editor's undo stack: ⌘Z takes it back.
        document.execCommand('insertHTML', false, textToHtml(r.text))
        updateCompose({ body: el.innerHTML })
        setAiOpen(false)
      } finally {
        if (current()) setAiBusy(false)
      }
    },
    [aiScope, compose.sourceMessageId, updateCompose]
  )

  /** Inserts at the current selection, which the caller has placed. */
  const insertSnippet = useCallback(
    (s: Snippet) => {
      const text = expandSnippet(s.body, snippetVars({ to: compose.to, me, now: new Date() }))
      document.execCommand('insertHTML', false, snippetHtml(text))
      const el = editorRef.current
      if (el) updateCompose({ body: el.innerHTML })
    },
    [compose.to, me, updateCompose]
  )

  /** `;thx` then ⇥ expands in place. Any other Tab keeps its normal meaning. */
  const onEditorKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      const sel = window.getSelection()
      if (!sel || !sel.rangeCount || !sel.isCollapsed) return
      const range = sel.getRangeAt(0)
      const node = range.startContainer
      if (node.nodeType !== Node.TEXT_NODE || !editorRef.current?.contains(node)) return
      const shortcut = shortcutBeforeCaret((node.textContent ?? '').slice(0, range.startOffset))
      if (!shortcut) return
      const snip = snippets.find((s) => s.shortcut?.toLowerCase() === shortcut.toLowerCase())
      if (!snip) return
      e.preventDefault()
      // Select the typed `;thx` so the snippet replaces it.
      const typed = document.createRange()
      typed.setStart(node, range.startOffset - shortcut.length - 1)
      typed.setEnd(node, range.startOffset)
      sel.removeAllRanges()
      sel.addRange(typed)
      insertSnippet(snip)
    },
    [snippets, insertSnippet]
  )

  // The picker's filter input took focus, so put the caret captured at ⌘;
  // back first (or the end of the body when there was none).
  const pickSnippet = useCallback(
    (id: string) => {
      setPickingSnippet(false)
      const snip = snippets.find((s) => String(s.id) === id)
      const el = editorRef.current
      if (!snip || !el) return
      el.focus()
      const sel = window.getSelection()
      if (!sel) return
      sel.removeAllRanges()
      if (caretRef.current) sel.addRange(caretRef.current)
      else {
        const end = document.createRange()
        end.selectNodeContents(el)
        end.collapse(false)
        sel.addRange(end)
      }
      insertSnippet(snip)
    },
    [snippets, insertSnippet]
  )

  const onPickFiles = useCallback(async () => {
    const picked = await window.api.pickAttachments()
    if (picked.length) {
      updateCompose({ attachments: [...compose.attachments, ...picked] })
    }
  }, [compose.attachments, updateCompose])

  /** `sendAt` null = now: main adds the undo window, whose length is a setting it owns. */
  const persistAndQueue = useCallback(
    async (sendAt: number | null, opts: { done?: boolean; cancelOnReply?: boolean } = {}) => {
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
        // outbound markup can still be corrected. The signature/quote markers
        // stay so a reopened draft still scopes Write with AI; main strips
        // them from what actually goes out.
        const body = cleanPastedHtml(editorRef.current?.innerHTML ?? compose.body, { keepMarkers: true })
        const saved = await window.api.saveDraft({
          draftId: compose.draftId,
          to: compose.to,
          cc: compose.cc,
          bcc: compose.bcc,
          subject: compose.subject,
          body,
          inReplyTo: compose.inReplyTo,
          references: compose.references,
          attachments: compose.attachments,
          accountId: compose.accountId
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
          remindAt: compose.remindAt,
          accountId: compose.accountId,
          cancelOnReply: !!opts.cancelOnReply
        })
        if (!queued.ok) {
          setError(queued.error)
          return
        }
        onSent(
          queued.outboxId,
          compose.subject || '(no subject)',
          Math.max(0, queued.sendAt - Date.now()),
          sendAt === null,
          opts.done ? compose.sourceMessageId : null
        )
        onClose()
      } finally {
        sendingRef.current = false
        setSending(false)
      }
    },
    [compose, onClose, onSent, updateCompose]
  )

  const introduce = useCallback(() => {
    const next = instantIntro({
      to: compose.to,
      cc: compose.cc,
      bcc: compose.bcc,
      body: editorRef.current?.innerHTML ?? compose.body
    })
    if (!next) return setError('Instant intro needs someone left to write to')
    // The DOM owns the body after the first seed, so write it there too.
    if (editorRef.current) editorRef.current.innerHTML = next.body
    updateCompose(next)
  }, [compose, updateCompose])

  const focusField = (id: string) => () => {
    // Cc / Bcc may still be folded away; unfold, then focus once rendered.
    if (id !== 'compose-to' && id !== 'compose-subject') setShowCc(true)
    requestAnimationFrame(() => document.getElementById(id)?.focus())
  }
  // Each chord is declared in commands.ts (compose.*, external) so the sheet lists it.
  const chords = useMemo(
    () => [
      { key: 'Enter', handler: () => void (!sending && persistAndQueue(null)) },
      { key: 'Enter', shift: true, handler: () => void (!sending && persistAndQueue(null, { done: true })) },
      { key: 'h', shift: true, handler: () => setReminding(true) },
      { key: 'l', shift: true, handler: () => setLaterOpen(true) },
      { key: 'i', shift: true, handler: introduce },
      { key: 'o', shift: true, handler: focusField('compose-to') },
      { key: 'c', shift: true, handler: focusField('compose-cc') },
      { key: 'b', shift: true, handler: focusField('compose-bcc') },
      { key: 's', shift: true, handler: focusField('compose-subject') },
      {
        key: ';',
        handler: () => {
          caretRef.current = captureCaret(editorRef.current)
          setPickingSnippet(true)
        }
      },
      { key: 'j', handler: openAi }
    ],
    [persistAndQueue, sending, introduce, openAi]
  )
  useCommandChord(chords)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !laterOpen && !reminding && !pickingSnippet && !aiOpen) {
        e.preventDefault()
        void closeKeepingDraft()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeKeepingDraft, laterOpen, reminding, pickingSnippet, aiOpen])

  // A reply already has its subject in the thread above; a forward and a new
  // message need the field.
  const showSubject = !inline || compose.mode === 'forward'
  // Bcc-only (undisclosed recipients) mail is valid, so any recipient field counts.
  const canSend = !sending && !!(compose.to.trim() || compose.cc.trim() || compose.bcc.trim())
  // A reply's quoted original and a forward's forwarded message both fold.
  const quoteFolded = compose.mode !== 'new' && !showQuote && compose.body.includes('supermail-quote')

  // An inline reply scrolls into view and takes the caret, like Scape's.
  useEffect(() => {
    if (!inline) return
    cardRef.current?.scrollIntoView({ block: 'nearest' })
    if (compose.to) {
      const el = editorRef.current
      el?.focus()
      if (el) {
        // Inside the first line, so typing does not leave an empty line above.
        const r = document.createRange()
        r.setStart(el.firstElementChild ?? el, 0)
        r.collapse(true)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(r)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inline, compose.draftId])

  const card = (
    <div className="compose-card" ref={cardRef} data-inline={inline} data-quote-folded={quoteFolded}>
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
      {error && (
        <div className="compose-error" role="alert">
          {error}
        </div>
      )}
      <div className="compose-fields">
        <div className="compose-to-row">
          <RecipientField
            label="To"
            value={compose.to}
            onChange={(to) => updateCompose({ to })}
            inputId="compose-to"
            autoFocus={!inline || !compose.to}
          />
          {!showCc && (
            <button type="button" className="compose-ccbcc" onClick={focusField('compose-cc')}>
              Cc / Bcc
            </button>
          )}
        </div>
        {showCc && (
          <>
            <RecipientField
              label="Cc"
              value={compose.cc}
              onChange={(cc) => updateCompose({ cc })}
              inputId="compose-cc"
            />
            <RecipientField
              label="Bcc"
              value={compose.bcc}
              onChange={(bcc) => updateCompose({ bcc })}
              inputId="compose-bcc"
            />
          </>
        )}
        {showSubject && (
          <label className="compose-field">
            <span>Subject</span>
            <input
              id="compose-subject"
              value={compose.subject}
              onChange={(e) => updateCompose({ subject: e.target.value })}
            />
          </label>
        )}
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
      {aiOpen && (
        <AiWriteMenu
          scope={aiScope}
          busy={aiBusy}
          error={aiError}
          focusKey={aiFocus}
          onRun={(action, instruction) => void runAi(action, instruction)}
          onClose={() => {
            aiReq.current.cancel()
            setAiBusy(false)
            setAiOpen(false)
            editorRef.current?.focus()
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
        data-placeholder="Write your message, or press ⌘J to draft it with AI"
        onInput={(e) => updateCompose({ body: e.currentTarget.innerHTML })}
        onPaste={onPaste}
        onKeyDown={onEditorKeyDown}
        onKeyUp={refreshFormats}
      />
      {quoteFolded && (
        <button type="button" className="compose-quote-toggle" title={compose.mode === 'forward' ? 'Show forwarded message' : 'Show quoted text'} aria-label={compose.mode === 'forward' ? 'Show forwarded message' : 'Show quoted text'} onClick={() => setShowQuote(true)}>
          <Ellipsis size={14} strokeWidth={2} />
        </button>
      )}
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
      {/* Scape's footer: tool pills on the left, reminder, then later + send. */}
      <div className="compose-footer">
        <span className="compose-pill">
          <button
            type="button"
            title="Attach files"
            aria-label="Attach files"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void onPickFiles()}
          >
            <Paperclip size={15} strokeWidth={1.75} />
          </button>
          <button type="button" title="Discard (Esc)" aria-label="Discard" onClick={onClose} disabled={sending}>
            <Trash2 size={15} strokeWidth={1.75} />
          </button>
        </span>
        <span className="compose-pill">
          {TOOLS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.cmd}
                type="button"
                title={t.title}
                aria-label={t.title}
                aria-pressed={!!activeFormats[t.cmd]}
                data-on={!!activeFormats[t.cmd]}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => exec(t.cmd)}
              >
                <Icon size={15} strokeWidth={1.75} />
              </button>
            )
          })}
          <button
            type="button"
            title="Insert link"
            aria-label="Insert link"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onLink}
          >
            <Link2 size={15} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            title="Write with AI ⌘J"
            aria-label="Write with AI"
            onMouseDown={(e) => e.preventDefault()}
            onClick={openAi}
          >
            <Sparkles size={15} strokeWidth={1.75} />
          </button>
        </span>
        <span className="compose-footer-sep" />
        <button type="button" className="compose-reminder" onClick={() => setReminding(true)} title="Remind me if no reply (⌘⇧H)">
          <Clock size={15} strokeWidth={1.75} />
          {compose.remindAt ? 'Reminder set' : 'No reminder'}
          <ChevronDown size={14} strokeWidth={1.75} />
        </button>
        <span className="compose-footer-spacer" />
        <button
          type="button"
          className="compose-later"
          onClick={() => setLaterOpen(true)}
          disabled={sending}
          title="Send later (⌘⇧L)"
          aria-label="Send later"
        >
          <SendHorizontal size={15} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="compose-send"
          disabled={!canSend}
          onClick={() => void persistAndQueue(null)}
          title={sending ? 'Queuing…' : 'Send (⌘↵)'}
          aria-label="Send"
        >
          <ArrowUp size={16} strokeWidth={2.25} />
        </button>
      </div>
    </div>
  )

  const pickers = (
    <>
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
      {laterOpen && (
        <RemindPicker
          title="Send later"
          // Only a reply has a thread someone could answer before it goes out.
          showCheck={!!compose.inReplyTo}
          checkLabel="Cancel if someone replies first"
          defaultIfNoReply={cancelOnReplyDefault}
          onPick={(at, cancelOnReply) => {
            setLaterOpen(false)
            void persistAndQueue(at, { cancelOnReply })
          }}
          onClose={() => setLaterOpen(false)}
        />
      )}
      {pickingSnippet && (
        <Picker
          title="Insert snippet"
          items={snippets.map((s) => ({ id: String(s.id), label: s.shortcut ? `${s.name}  ;${s.shortcut}` : s.name }))}
          emptyText="No snippets yet. Add them in Settings → Snippets."
          onPick={pickSnippet}
          onClose={() => setPickingSnippet(false)}
        />
      )}
    </>
  )

  if (inline) {
    return (
      <>
        {pickers}
        {card}
      </>
    )
  }

  return (
    <div className="compose">
      {/* Same bar as a thread: round back on the left, discard on the right. */}
      <header className="thread-toolbar">
        <button className="thread-circle" onClick={() => void closeKeepingDraft()} aria-label="Close and keep draft" title="Close (Esc) — keeps a draft">
          <ArrowLeft size={16} strokeWidth={1.75} />
        </button>
        <span className="thread-toolbar-subject" />
        <span className="thread-pill">
          <button type="button" title="Discard (Esc)" aria-label="Discard" onClick={onClose} disabled={sending}>
            <Trash2 size={15} strokeWidth={1.75} />
          </button>
        </span>
      </header>
      {pickers}
      <div className="thread-scroll">
        <div className="thread-column">
          <h1 className="thread-title compose-heading" data-empty={!compose.subject.trim()}>
            {compose.subject.trim() || (compose.mode === 'new' || !compose.mode ? 'New email' : title)}
          </h1>
          {card}
        </div>
      </div>
    </div>
  )
}
