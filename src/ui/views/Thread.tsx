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
import { decodeEntities, formatDate, senderLabel } from '../format'
import { cycleIndex, openActiveTarget, stepIndex, toggleAllExpanded } from '../threadNav'
import { previewKind } from './AttachmentPreview'
import { MessageBody } from './MessageBody'

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
  const onLoadedRef = useRef(onLoaded)
  onLoadedRef.current = onLoaded

  useEffect(() => {
    let cancelled = false
    window.api.getThread(threadId, accountId).then((m) => {
      if (cancelled) return
      setMessages(m)
      loaded.current.clear()
      // Open the message that was selected, or the newest if it's not here.
      // Newest is first: the thread is ordered date DESC.
      const i = Math.max(0, m.findIndex((x) => x.id === focusMessageId))
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
      }
    }
  }, [messages, focused, expanded, activeLink, onAttachment])

  if (!messages) return <div className="thread-loading" />
  if (!messages.length)
    return (
      <div className="empty">
        <span>Message not found</span>
      </div>
    )

  const subject = messages.find((m) => m.subject)?.subject ?? '(no subject)'

  return (
    <div className="thread">
      <header className="thread-header">
        <button className="back-button" onClick={onBack} aria-label="Back to list">
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
        <h2 className="thread-subject">{subject}</h2>
        <span className="thread-count">
          {messages.length} message{messages.length === 1 ? '' : 's'}
        </span>
        {position && (
          <span className="thread-position">
            <button
              type="button"
              title="Previous conversation (k)"
              aria-label="Previous conversation"
              onClick={onPrevConversation}
            >
              <ChevronUp size={14} strokeWidth={2} />
            </button>
            <span>{position}</span>
            <button
              type="button"
              title="Next conversation (j)"
              aria-label="Next conversation"
              onClick={onNextConversation}
            >
              <ChevronDown size={14} strokeWidth={2} />
            </button>
          </span>
        )}
        <div className="thread-actions">
          <button type="button" title="Done (e)" aria-label="Done" onClick={onDone}>
            <Archive size={15} strokeWidth={2} />
          </button>
          <button type="button" title="Trash (⌫)" aria-label="Trash" onClick={onTrash}>
            <Trash2 size={15} strokeWidth={2} />
          </button>
          <button
            type="button"
            title="Star (s)"
            aria-label="Star"
            aria-pressed={starred}
            data-on={starred}
            onClick={onStar}
          >
            <Star size={15} strokeWidth={2} fill={starred ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            title="Mark unread (u)"
            aria-label="Mark unread"
            onClick={onToggleRead}
          >
            <MailOpen size={15} strokeWidth={2} />
          </button>
        </div>
      </header>

      <div className="thread-scroll" ref={scrollRef}>
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
                <span className="message-date">{formatDate(m.date)}</span>
              </button>
              {open && (
                <MessageBody
                  messageId={m.id}
                  activeLink={i === focused ? activeLink : null}
                  onLoaded={(info) => loaded.current.set(m.id, info)}
                />
              )}
            </article>
          )
        })}

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
  )
})
