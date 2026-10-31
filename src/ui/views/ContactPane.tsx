import { useEffect, useState } from 'react'
import type { ContactProfile } from '../../core/store/contacts'
import { formatDate } from '../format'

interface Props {
  threadId: string
  accountId?: number
  /** False until the thread itself has loaded: the lookup must never delay it. */
  ready: boolean
  onOpen: (threadId: string, messageId: number, accountId: number) => void
}

/** Who this thread is with, from the local DB only: no third-party enrichment. */
export function ContactPane({ threadId, accountId, ready, onOpen }: Props) {
  const [p, setP] = useState<ContactProfile | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setP(undefined)
    if (!ready) return
    // Main runs IPC in order: wait for idle so the thread's body requests go first.
    const run = (): void => {
      void window.api.contactForThread(threadId, accountId).then((r) => {
        if (!cancelled) setP(r)
      })
    }
    const idle = typeof window.requestIdleCallback === 'function'
    const handle = idle ? window.requestIdleCallback(run, { timeout: 500 }) : window.setTimeout(run, 50)
    return () => {
      cancelled = true
      if (idle) window.cancelIdleCallback(handle)
      else window.clearTimeout(handle)
    }
  }, [threadId, accountId, ready])

  if (p === undefined) return <aside className="contact-pane" aria-busy="true" />
  if (p === null) return null
  return (
    <aside className="contact-pane" aria-label="Contact">
      <div className="contact-head">
        <div className="contact-name" title={p.name ?? p.address}>{p.name ?? p.address}</div>
        {p.name && <div className="contact-addr" title={p.address}>{p.address}</div>}
      </div>
      <dl className="contact-stats">
        <div>
          <dt>Emails</dt>
          <dd>
            {p.received} from · {p.sent} to
          </dd>
        </div>
        <div>
          <dt>You replied</dt>
          <dd>
            {p.repliedThreads} of {p.threads} conversations
          </dd>
        </div>
        {p.lastContact && (
          <div>
            <dt>Last</dt>
            <dd>{formatDate(p.lastContact)}</dd>
          </div>
        )}
      </dl>
      <h4>Recent</h4>
      <ul className="contact-recent">
        {p.recent.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              title={r.subject || '(no subject)'}
              onClick={() => r.thread_id && onOpen(r.thread_id, r.id, r.account_id)}
            >
              <span className="contact-subject">{r.subject || '(no subject)'}</span>
              <span className="contact-date">{formatDate(r.date)}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
