interface ComposeWhere {
  mode: 'new' | 'reply' | 'replyAll' | 'forward'
  /** The thread a reply or forward belongs to. */
  threadId?: string | null
  accountId: number | null
}

/**
 * A reply or forward is written at the end of the thread it answers (Scape).
 * Anywhere else, or for a new message, it gets the compose page, so a reply
 * can never sit under, and Send + Done never act on, a different thread.
 */
export function composeInline(
  compose: ComposeWhere | null,
  open: { threadId: string; accountId?: number | null } | null,
  tasksOpen: boolean
): boolean {
  if (!compose || !open || tasksOpen || compose.mode === 'new') return false
  return compose.threadId === open.threadId && (open.accountId == null || compose.accountId === open.accountId)
}

export interface ComposeSnapshot {
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
  attachments: number
}

/** Esc / back keep a draft only when there is something new to keep. */
export function composeDirty(initial: ComposeSnapshot, now: ComposeSnapshot): boolean {
  return (
    initial.to !== now.to ||
    initial.cc !== now.cc ||
    initial.bcc !== now.bcc ||
    initial.subject !== now.subject ||
    initial.body !== now.body ||
    initial.attachments !== now.attachments
  )
}
