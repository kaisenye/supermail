import { statusGate, type Ai } from '../services/ai/service.js'
import type { AiRequest } from '../services/ai/types.js'
import { setSummary } from '../store/ai.js'
import { getThread } from '../store/repo.js'
import type { Message } from '../store/types.js'
import { MAIL_IS_DATA, messageText, transcript } from './mailText.js'

/** A lone message shorter than this reads faster than its summary. */
export const SUMMARY_MIN_CHARS = 600
/** Newest messages a summary reads. */
const SUMMARY_DEPTH = 8

/**
 * Worth a summary: more than one message, or one long one. The store read
 * (threadInsights) and summarizeThread share this rule, so the thread view
 * never starts a run that is bound to come back empty. A body not stored yet
 * reads as its snippet, so a lone unfetched message counts as short until
 * its body arrives.
 */
export function summarizable(msgs: Pick<Message, 'body_text' | 'body_html' | 'snippet'>[]): boolean {
  if (msgs.length !== 1) return msgs.length > 1
  return messageText(msgs[0]).length >= SUMMARY_MIN_CHARS
}

export function summaryRequest(subject: string | null, thread: string): AiRequest {
  return {
    system: [
      'You summarize email conversations for a busy reader.',
      'Reply with one plain sentence of at most 25 words: what the conversation is about, and what, if anything, the reader needs to do.',
      'No preamble, no quotes, no markdown.',
      MAIL_IS_DATA
    ].join(' '),
    prompt: `Subject: ${subject ?? '(none)'}\n\n${thread}`,
    maxTokens: 2000
  }
}

/** First line, without wrapping quotes or markdown, at most 300 characters. */
export function cleanLine(text: string): string {
  const first = text.trim().split(/\r?\n/)[0] ?? ''
  return first.replace(/^[*_#>\s"“']+|[*_\s"”']+$/g, '').slice(0, 300)
}

export interface SummaryDeps {
  ai: Ai
  /** Fetches bodies that are not stored yet (ensureBody in main). */
  ensureBodies: (accountId: number, ids: number[]) => Promise<void>
}

export interface SummaryResult {
  summary: string | null
  cached: boolean
}

/** Cached on the thread's newest message (messages.summary), so a new reply makes it stale by itself. */
export async function summarizeThread(
  deps: SummaryDeps,
  accountId: number,
  threadId: string
): Promise<SummaryResult> {
  // Before the cache: a stored line must not outlive the switch or the key.
  const blocked = statusGate(deps.ai.status(), 'summary')
  if (blocked) throw blocked
  let msgs = getThread(accountId, threadId)
  if (!msgs.length) return { summary: null, cached: false }
  if (msgs[0].summary) return { summary: msgs[0].summary, cached: true }
  const missing = msgs
    .slice(0, SUMMARY_DEPTH)
    .filter((m) => !m.body_fetched && m.folder_id !== null)
    .map((m) => m.id)
  if (missing.length) {
    await deps.ensureBodies(accountId, missing)
    msgs = getThread(accountId, threadId)
  }
  if (!summarizable(msgs)) return { summary: null, cached: false }
  const subject = msgs.find((m) => m.subject)?.subject ?? null
  const r = await deps.ai.run('summary', summaryRequest(subject, transcript(msgs.slice(0, SUMMARY_DEPTH))))
  const line = cleanLine(r.text)
  if (!line) return { summary: null, cached: false }
  setSummary(msgs[0].id, line)
  return { summary: line, cached: false }
}

const inflight = new Map<string, Promise<SummaryResult>>()

/**
 * summarizeThread, but a second request for a thread already being summarized
 * (StrictMode double effect, j/k back to it, ⌘K during the auto run) joins the
 * first instead of paying the provider again.
 */
export function summarizeThreadOnce(deps: SummaryDeps, accountId: number, threadId: string): Promise<SummaryResult> {
  const k = `${accountId}:${threadId}`
  const running = inflight.get(k)
  if (running) return running
  const p = summarizeThread(deps, accountId, threadId).finally(() => inflight.delete(k))
  inflight.set(k, p)
  return p
}
