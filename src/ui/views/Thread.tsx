import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Forward,
  MailOpen,
  Reply,
  ReplyAll,
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
  /** A reply or forward being written: shown at the end, in place of the reply buttons. */
  composer?: ReactNode
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
    composer,
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
  /** The first focus after a load lands on the newest message's top. */
  const landing = useRef(false)
  const titleRef = useRef<HTMLHeadingElement>(null)
  /** The big title has scrolled away, so the bar shows the subject instead. */
  const [compact, setCompact] = useState(false)
  /** Where the long-thread jump buttons stand: hidden when nothing scrolls. */
  const [edges, setEdges] = useState({ scrollable: false, top: true, bottom: true })
  const onLoadedRef = useRef(onLoaded)
  onLoadedRef.current = onLoaded
  const ai = useAiInsights(threadId, accountId)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => {
      const next = {
        scrollable: el.scrollHeight > el.clientHeight + 40,
        top: el.scrollTop <= 4,
        bottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 4
      }
      setEdges((prev) =>
        prev.scrollable === next.scrollable && prev.top === next.top && prev.bottom === next.bottom ? prev : next
      )
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    // Bodies load after the thread paints and change its height.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => {
      el.removeEventListener('scroll', measure)
      ro.disconnect()
    }
  }, [messages])

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
      // Open on the newest message, yours or theirs (the row is the newest
      // in its folder, so in the Inbox it skips your own later reply). The
      // focus effect then scrolls it into view.
      const i = m.length - 1
      landing.current = true
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
    const el = scrollRef.current?.querySelector(`[data-index="${focused}"]`)
    if (!el) return
    // Oldest-first puts the newest message last: 'nearest' would leave its
    // header at the bottom edge and the body, still loading, below the fold.
    el.scrollIntoView({ block: landing.current ? 'start' : 'nearest' })
    landing.current = false
  }, [focused, messages])

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

      {edges.scrollable && (
        <div className="thread-jump" role="group" aria-label="Jump">
          <button
            type="button"
            aria-label="Jump to top"
            title="Top"
            disabled={edges.top}
            onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
          >
            <ChevronUp size={16} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="Jump to bottom"
            title="Bottom"
            disabled={edges.bottom}
            onClick={() => {
              const el = scrollRef.current
              el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
            }}
          >
            <ChevronDown size={16} strokeWidth={1.75} />
          </button>
        </div>
      )}

      {!composer && (
        <div className="thread-reply-bar" role="group" aria-label="Respond">
          <button type="button" onClick={() => onReply(false)}>
            <Reply size={15} strokeWidth={2} /> Reply
            <span className="thread-reply-hint">r</span>
          </button>
          {/* The less common two show only their icon until hovered. */}
          <button type="button" className="thread-reply-more" aria-label="Reply all" title="Reply all (↵)" onClick={() => onReply(true)}>
            <ReplyAll size={15} strokeWidth={2} />
            <span className="thread-reply-label">
              Reply all <span className="thread-reply-hint">↵</span>
            </span>
          </button>
          <button type="button" className="thread-reply-more" aria-label="Forward" title="Forward (f)" onClick={onForward}>
            <Forward size={15} strokeWidth={2} />
            <span className="thread-reply-label">
              Forward <span className="thread-reply-hint">f</span>
            </span>
          </button>
        </div>
      )}

      <div className="thread-scroll" ref={scrollRef} data-reply-bar={!composer}>
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

        {/* Once started, a reply is written right at the end of the
            conversation, where you finish reading (Scape). */}
        {composer}
        </div>
      </div>
    </div>
  )
})
