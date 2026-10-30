interface Props {
  streak: number
}

/** Shown in place of the empty Inbox. Local only: the streak lives in settings. */
export function ZeroState({ streak }: Props) {
  return (
    <div className="zero-state">
      <svg width="120" height="80" viewBox="0 0 120 80" aria-hidden="true">
        <circle cx="60" cy="52" r="22" fill="none" stroke="currentColor" strokeWidth="2" />
        <line x1="10" y1="52" x2="110" y2="52" stroke="currentColor" strokeWidth="2" />
        <line x1="60" y1="18" x2="60" y2="8" stroke="currentColor" strokeWidth="2" />
        <line x1="34" y1="28" x2="28" y2="21" stroke="currentColor" strokeWidth="2" />
        <line x1="86" y1="28" x2="92" y2="21" stroke="currentColor" strokeWidth="2" />
      </svg>
      <span className="empty-title">Inbox zero</span>
      <span className="empty-sub">{streak > 1 ? `${streak} days in a row` : 'Nothing left to triage'}</span>
    </div>
  )
}
