import type { AiFeature } from '../services/ai/types.js'
import { getClassification, getReplyOptions, type Classification } from '../store/ai.js'
import { getDb } from '../store/db.js'
import { getThread } from '../store/repo.js'
import { candidate, repliesEligible } from './eligibility.js'
import { summarizable } from './summary.js'

/** What the thread view shows from AI. Reads the store only; never calls a provider. */
export interface ThreadInsights {
  /** The cached summary line, or null when none is stored for the newest message or Summaries cannot run. */
  summary: string | null
  /**
   * More than one message, or one long one (summary.ts `summarizable`). The
   * thread view auto-summarizes only when this holds, so a short note never
   * flashes "Summarizing…". False while Summaries cannot run.
   */
  summarizable: boolean
  /** The newest verdict in the thread: why it sits in Important or Other. Null while the classifier cannot run. */
  classification: Classification | null
  /** The message Instant Reply would answer (newest from someone else), when it qualifies. Null while Instant Reply cannot run. */
  replyTarget: number | null
  /** Cached suggestions for replyTarget. */
  replies: { messageRowId: number; options: string[] } | null
}

/** `features` is AiStatus.features: a feature that is off (or has no key) shows nothing, cached or not. */
export function threadInsights(
  accountId: number,
  threadId: string,
  features: Record<AiFeature, boolean>
): ThreadInsights {
  const none: ThreadInsights = {
    summary: null,
    summarizable: false,
    classification: null,
    replyTarget: null,
    replies: null
  }
  if (!features.summary && !features.classify && !features.replies) return none
  const msgs = getThread(accountId, threadId)
  let classification: Classification | null = null
  if (features.classify) {
    for (const m of msgs) {
      if (!m.message_id) continue
      classification = getClassification(accountId, m.message_id)
      if (classification) break
    }
  }
  return {
    ...none,
    ...(features.summary ? { summary: msgs[0]?.summary ?? null, summarizable: summarizable(msgs) } : {}),
    classification,
    ...(features.replies ? replyInsights(accountId, msgs) : {})
  }
}

function replyInsights(
  accountId: number,
  msgs: ReturnType<typeof getThread>
): Pick<ThreadInsights, 'replyTarget' | 'replies'> {
  const me = (
    getDb().prepare('SELECT lower(email) AS e FROM accounts WHERE id = ?').get(accountId) as { e: string } | undefined
  )?.e
  // Newest first: the latest message someone else sent that is still in a folder.
  const inbound = msgs.find((m) => m.folder_id !== null && (m.from_addr ?? '').toLowerCase() !== me)
  const c = inbound ? candidate(inbound.id) : null
  const replyTarget = c && repliesEligible(c, Date.now(), { fresh: false }) ? c.id : null
  const options = replyTarget && c?.message_id ? getReplyOptions(accountId, c.message_id) : null
  return { replyTarget, replies: replyTarget && options ? { messageRowId: replyTarget, options } : null }
}
