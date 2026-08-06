import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpLeft,
  ArrowUpRight,
  MailOpen,
  Star,
  Trash2
} from 'lucide-react'
import type { Message } from '../../core/store/types'
import { decodeEntities, formatDate, senderLabel } from '../format'
import { MessageBody } from './MessageBody'

interface Props {
  threadId: string
  focusMessageId: number
  onBack: () => void
  onReply: (all: boolean) => void
  onForward: () => void
  onTrash: () => void
  onStar: () => void
  onToggleRead: () => void
  starred: boolean
}

export function Thread({
  threadId,
  focusMessageId,
  onBack,
  onReply,
  onForward,
  onTrash,
  onStar,
  onToggleRead,
  starred
}: Props) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set([focusMessageId]))

  useEffect(() => {
    let cancelled = false
    window.api.getThread(threadId).then((m) => {
      if (cancelled) return
      setMessages(m)
      // Open the message that was selected, or the newest if it's not here.
      // Newest is first: the thread is ordered date DESC.
      const target = m.some((x) => x.id === focusMessageId) ? focusMessageId : m[0]?.id
      if (target) setExpanded(new Set([target]))
    })
    return () => {
      cancelled = true
    }
  }, [threadId, focusMessageId])

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
        <div className="thread-actions">
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

      <div className="thread-scroll">
        {messages.map((m) => {
          const open = expanded.has(m.id)
          return (
            <article key={m.id} className="thread-message" data-open={open}>
              <button
                className="message-head"
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev)
                    if (next.has(m.id)) next.delete(m.id)
                    else next.add(m.id)
                    return next
                  })
                }
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
              {open && <MessageBody messageId={m.id} />}
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
            <span className="thread-reply-hint">⇧r</span>
          </button>
          <button type="button" onClick={onForward}>
            <ArrowUpRight size={14} strokeWidth={2} /> Forward
            <span className="thread-reply-hint">f</span>
          </button>
        </div>
      </div>
    </div>
  )
}
