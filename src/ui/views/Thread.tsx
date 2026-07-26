import { useEffect, useState } from 'react'
import type { Message } from '../../core/store/types'
import { formatDate, senderLabel } from '../format'
import { MessageBody } from './MessageBody'

interface Props {
  threadId: string
  focusMessageId: number
  onBack: () => void
}

export function Thread({ threadId, focusMessageId, onBack }: Props) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set([focusMessageId]))

  useEffect(() => {
    let cancelled = false
    window.api.getThread(threadId).then((m) => {
      if (cancelled) return
      setMessages(m)
      // Open the message that was selected, or the newest if it's not here.
      const target = m.some((x) => x.id === focusMessageId)
        ? focusMessageId
        : m[m.length - 1]?.id
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
          ←
        </button>
        <h2 className="thread-subject">{subject}</h2>
        <span className="thread-count">
          {messages.length} message{messages.length === 1 ? '' : 's'}
        </span>
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
                <span className="message-addr">{m.from_addr}</span>
                <span className="message-date">{formatDate(m.date)}</span>
              </button>
              {open && <MessageBody messageId={m.id} />}
            </article>
          )
        })}
      </div>
    </div>
  )
}
