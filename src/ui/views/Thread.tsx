import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  Archive,
  ArrowLeft,
  ArrowUpLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  MailOpen,
  Star,
  Trash2
} from 'lucide-react'
import type { Attachment } from '../../../electron/preload'
import type { Message } from '../../core/store/types'
import { decodeEntities, formatDate, formatFullDate, recipientNames, senderLabel } from '../format'
import { replyPick, type ReplyPick } from '../aiInsights'
import { useAiInsights } from '../hooks/useAiInsights'
import { cycleIndex, openActiveTarget, stepIndex, toggleAllExpanded } from '../threadNav'
import { previewKind } from './AttachmentPreview'
import { MessageBody } from './MessageBody'
import { ReplySuggestions, ThreadInsightsBar } from './ThreadInsights'

interface Props {
  threadId: string
  focusMessageId: number
  /** The account that owns the thread (thread ids collide across accounts); unset = the active one. */
  accountId?: number
  /** "15 / 201", or null when the thread is not in the list on screen. */
  position: string | null
  onPrevConversation: () => void
  onNextConversation: () => void
  onBack: () => void
  onReply: (all: boolean) => void
  /** An Instant Reply: App opens Reply with this text, addressed to the message it answers. */
  onReplyWith: (pick: ReplyPick) => void
  onForward: () => void
  onDone: () => void
  onTrash: () => void
  onStar: () => void
  onToggleRead: () => void
  /** ⌘O on an attachment: App previews it in-app, or confirms before opening it externally. */
  onAttachment: (attachment: Attachment, canPreview: boolean) => void
  /** The thread's messages are on screen (their body requests already sent). */
  onLoaded?: () => void
  starred: boolean
}

/** Driven by App's registry handlers: the keys live in commands.ts, the reading state lives here. */
export interface ThreadHandle {
  toggleFocused(): void
  toggleAll(): void
  step(delta: number): void
  page(dir: 1 | -1): void
  cycleLink(delta: number): void
  openActive(): void
  summarize(): void
  /** Instant Reply `i` (0-based) with the message it answers, or null when there is none. */
  replyOption(i: number): ReplyPick | null
}

export const Thread = forwardRef<ThreadHandle, Props>(function Thread(
  {
    threadId,
    focusMessageId,
    accountId,
    position,
    onPrevConversation,
    onNextConversation,
    onBack,
    onReply,
    onReplyWith,
    onForward,
    onDone,
    onTrash,
    onStar,
    onToggleRead,
    onAttachment,
    onLoaded,
    starred
  },
  ref
) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set([focusMessageId]))
  const [focused, setFocused] = useState(0)
  const [activeLink, setActiveLink] = useState<number | null>(null)
  /** Links and attachments of each body that has loaded, by message id. */
  const loaded = useRef(new Map<number, { links: string[]; attachments: Attachment[] }>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  /** The big title has scrolled away, so the bar shows the subject instead. */
  const [compact, setCompact] = useState(false)
  const onLoadedRef = useRef(onLoaded)
  onLoadedRef.current = onLoaded
  const ai = useAiInsights(threadId, accountId)

  useEffect(() => {
    const title = titleRef.current
    const root = scrollRef.current
    if (!title || !root || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setCompact(!e.isIntersecting), { root, threshold: 0 })
    io.observe(title)
    return () => io.disconnect()
  }, [messages])

  useEffect(() => {
    let cancelled = false
    window.api.getThread(threadId, accountId).then((desc) => {
      if (cancelled) return
      // Read top to bottom like a conversation (Scape): oldest first. Main
      // returns date DESC, so flip it here; every index below is in this order.
      const m = [...desc].reverse()
      setMessages(m)
      loaded.current.clear()
      // Open the message that was selected, or the newest (last) if it's not
      // here; the focus effect then scrolls it into view.
      const at = m.findIndex((x) => x.id === focusMessageId)
      const i = at === -1 ? m.length - 1 : at
      setFocused(i)
      setActiveLink(null)
      if (m[i]) setExpanded(new Set([m[i].id]))
      onLoadedRef.current?.()
    })
    return () => {
      cancelled = true
    }
  }, [threadId, focusMessageId, accountId])

  useEffect(() => {
    scrollRef.current
      ?.querySelector(`[data-index="${focused}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  useImperativeHandle(ref, (): ThreadHandle => {
    const ids = messages?.map((m) => m.id) ?? []
    const focusedId = ids[focused] ?? null
    return {
      toggleFocused: () => {
        if (focusedId === null) return
        setExpanded((prev) => {
          const next = new Set(prev)
          if (next.has(focusedId)) next.delete(focusedId)
          else next.add(focusedId)
          return next
        })
      },
      toggleAll: () => setExpanded((prev) => toggleAllExpanded(prev, ids, focusedId)),
      step: (delta: number) => {
        setFocused((i) => stepIndex(i, delta, ids.length))
        setActiveLink(null)
      },
      page: (dir: 1 | -1) => {
        const el = scrollRef.current
        if (el) el.scrollBy({ top: dir * el.clientHeight * 0.85 })
      },
      cycleLink: (delta: number) => {
        if (focusedId === null) return
        // Links come from the body, so a collapsed message opens first.
        if (!expanded.has(focusedId)) setExpanded((prev) => new Set(prev).add(focusedId))
        const n = loaded.current.get(focusedId)?.links.length ?? 0
        setActiveLink((i) => cycleIndex(i, delta, n))
      },
      openActive: () => {
        const info = focusedId === null ? undefined : loaded.current.get(focusedId)
        const t = openActiveTarget(info, activeLink, (a) => previewKind(a) !== null)
        if (!t) return
        if (t.kind === 'link') void window.api.openExternal(t.url)
        else onAttachment(t.attachment, t.kind === 'preview')
      },
      summarize: () => void ai.summarize(),
      replyOption: (i: number) => replyPick(ai.insights, i)
    }
  }, [messages, focused, expanded, activeLink, onAttachment, ai.summarize, ai.insights])

  if (!messages) return <div className="thread-loading" />
  if (!messages.length)
    return (
      <div className="empty">
        <span>Message not found</span>
      </div>
    )

  const subject = messages.find((m) => m.subject)?.subject ?? '(no subject)'
  const [current, total] = position ? position.split(' / ') : [null, null]

  return (
    <div className="thread">
      {/* No rule under the bar (Scape): the subject moves up into it once the
          big title has scrolled away. */}
      <header className="thread-toolbar" data-compact={compact}>
        <button className="thread-circle" onClick={onBack} aria-label="Back to list" title="Back (Esc)">
          <ArrowLeft size={16} strokeWidth={1.75} />
        </button>
        <h2 className="thread-toolbar-subject" aria-hidden={!compact}>
          {subject}
        </h2>
        <div className="thread-toolbar-right">
          {position && (
            <>
              <span className="thread-position">
                <b>{current}</b> / {total}
              </span>
              <span className="thread-pill">
                <button type="button" title="Previous conversation (k)" aria-label="Previous conversation" onClick={onPrevConversation}>
                  <ChevronUp size={16} strokeWidth={1.75} />
                </button>
                <button type="button" title="Next conversation (j)" aria-label="Next conversation" onClick={onNextConversation}>
                  <ChevronDown size={16} strokeWidth={1.75} />
                </button>
              </span>
            </>
          )}
          <span className="thread-pill">
            <button type="button" title="Star (s)" aria-label="Star" aria-pressed={starred} data-on={starred} onClick={onStar}>
              <Star size={15} strokeWidth={1.75} fill={starred ? 'currentColor' : 'none'} />
            </button>
            <button type="button" title="Mark unread (u)" aria-label="Mark unread" onClick={onToggleRead}>
              <MailOpen size={15} strokeWidth={1.75} />
            </button>
            <button type="button" title="Trash (⌫)" aria-label="Trash" onClick={onTrash}>
              <Trash2 size={15} strokeWidth={1.75} />
            </button>
          </span>
          <span className="thread-pill">
            <button type="button" title="Done (e)" aria-label="Done" onClick={onDone}>
              <Archive size={15} strokeWidth={1.75} />
            </button>
          </span>
        </div>
      </header>

      <ThreadInsightsBar insights={ai.insights} busy={ai.busy} error={ai.error} note={ai.note} />

      <div className="thread-scroll" ref={scrollRef}>
        <div className="thread-column">
        <h1 className="thread-title" ref={titleRef}>
          {subject}
        </h1>
        {messages.length > 1 && <div className="thread-meta">{messages.length} messages</div>}
        {messages.map((m, i) => {
          const open = expanded.has(m.id)
          return (
            <article
              key={m.id}
              className="thread-message"
              data-open={open}
              data-index={i}
              data-focused={i === focused}
            >
              <button
                className="message-head"
                onClick={() => {
                  setFocused(i)
                  setExpanded((prev) => {
                    const next = new Set(prev)
                    if (next.has(m.id)) next.delete(m.id)
                    else next.add(m.id)
                    return next
                  })
                }}
              >
                <span className="message-avatar" aria-hidden="true">
                  {senderLabel(m.from_name, m.from_addr).slice(0, 1).toUpperCase()}
                </span>
                <span className="message-sender">
                  {senderLabel(m.from_name, m.from_addr)}
                </span>
                {/* Collapsed rows swap the address for a preview, so a long
                    thread can be skimmed without opening every message. */}
                {open ? (
                  <span className="message-addr">{m.from_addr}</span>
                ) : (
                  <span className="message-preview">{decodeEntities(m.snippet)}</span>
                )}
                <span className="message-date">{open ? formatFullDate(m.date) : formatDate(m.date)}</span>
              </button>
              {open && (
                <div className="message-card">
                  {recipientNames(m.to_addrs, m.cc_addrs) && (
                    <div className="message-to">
                      <span>To:</span> {recipientNames(m.to_addrs, m.cc_addrs)}
                    </div>
                  )}
                  <MessageBody
                    messageId={m.id}
                    activeLink={i === focused ? activeLink : null}
                    onLoaded={(info) => {
                      loaded.current.set(m.id, info)
                      ai.bodyLoaded()
                    }}
                  />
                </div>
              )}
            </article>
          )
        })}

        <ReplySuggestions insights={ai.insights} busy={ai.busy} onUse={onReplyWith} />

        {/* Reply lives at the end of the conversation, where you finish reading. */}
        <div className="thread-reply-bar">
          <button type="button" onClick={() => onReply(false)}>
            <ArrowUpLeft size={14} strokeWidth={2} /> Reply
            <span className="thread-reply-hint">r</span>
          </button>
          <button type="button" onClick={() => onReply(true)}>
            <ArrowUpLeft size={14} strokeWidth={2} /> Reply all
            <span className="thread-reply-hint">↵</span>
          </button>
          <button type="button" onClick={onForward}>
            <ArrowUpRight size={14} strokeWidth={2} /> Forward
            <span className="thread-reply-hint">f</span>
          </button>
        </div>
        </div>
      </div>
    </div>
  )
})
