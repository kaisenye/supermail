import type { AiInsights } from '../../../electron/preload'
import type { ReplyPick } from '../aiInsights'
import type { AiBusy } from '../hooks/useAiInsights'

interface Props {
  insights: AiInsights | null
  busy: AiBusy
  error: string | null
  /** A muted line such as "Too short to summarize". */
  note?: string | null
}

/** The summary line and the classifier's reason, under the thread header. */
export function ThreadInsightsBar({ insights, busy, error, note }: Props) {
  if (!insights) return null
  const { summary, classification: c } = insights
  if (!summary && !c && busy !== 'summary' && !error && !note) return null
  return (
    <div className="ai-insights">
      {busy === 'summary' ? (
        <p className="ai-summary ai-muted">Summarizing…</p>
      ) : summary ? (
        <p className="ai-summary">{summary}</p>
      ) : note ? (
        <p className="ai-summary ai-muted">{note}</p>
      ) : null}
      {c && (
        <p className="ai-why" title={`Sorted by ${c.model}`}>
          <span className="ai-why-chip" data-important={c.important}>
            {c.important ? 'Important' : 'Other'} · {c.category}
          </span>
          {c.reason}
        </p>
      )}
      {error && <p className="ai-error">{error}</p>}
    </div>
  )
}

/** Instant Reply: three suggestions above the reply bar; 1–3 or a click opens a reply with one. */
export function ReplySuggestions({
  insights,
  busy,
  onUse
}: {
  insights: AiInsights | null
  busy: AiBusy
  onUse: (pick: ReplyPick) => void
}) {
  const replies = insights?.replies
  const options = replies?.options ?? []
  if (busy === 'replies' && !options.length) return <div className="ai-replies ai-muted">Suggesting replies…</div>
  if (!options.length) return null
  return (
    <div className="ai-replies" aria-label="Instant replies">
      {options.map((o, i) => (
        <button key={i} type="button" title={o} onClick={() => replies && onUse({ text: o, messageRowId: replies.messageRowId })}>
          <span className="thread-reply-hint">{i + 1}</span>
          <span className="ai-reply-text">{o}</span>
        </button>
      ))}
    </div>
  )
}
