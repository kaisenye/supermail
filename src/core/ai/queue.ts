import type { Ai } from '../services/ai/service.js'
import { readAiSettings } from '../services/ai/settings.js'
import { AiError, type AiErrorCode } from '../services/ai/types.js'
import { listAiLabels } from '../store/aiLabels.js'
import { dueAiJobs, enqueueAiJob, expireAiJobs, finishAiJob, pruneAiJobs, retryAiJob, type AiJob, type AiJobKind } from '../store/ai.js'
import { refreshListRows } from '../store/listRows.js'
import { getSettings } from '../store/repo.js'
import { classifyMessage } from './classify.js'
import { labelMessage, labelsEligible } from './labels.js'
import { candidate, classifyEligible, FRESH_MS, inboxCopyOf, repliesEligible } from './eligibility.js'
import { suggestRepliesOnce } from './replies.js'

/** Background features, in the order a message is worked on. */
export const BACKGROUND_KINDS: AiJobKind[] = ['classify', 'replies', 'labels']

/** The settings switch each job kind runs under: custom labels go with the classifier. */
export const KIND_FEATURE: Record<AiJobKind, 'classify' | 'replies'> = {
  classify: 'classify',
  replies: 'replies',
  labels: 'classify'
}

const WEEK_MS = 7 * 24 * 3600_000
/** These stop the whole run and leave the job pending: nothing else would succeed either. */
const STOPPERS = new Set<AiErrorCode>(['budget', 'no-key', 'auth', 'rate'])

/**
 * Called by the pipeline after every stored message. Cheap: one settings read,
 * and one row read only when a background feature is on. Never calls a provider.
 */
export function enqueueForMessage(messageRowId: number, now = Date.now()): AiJobKind[] {
  const s = readAiSettings(getSettings())
  const kinds = BACKGROUND_KINDS.filter((k) => s.toggles[KIND_FEATURE[k]])
  if (!kinds.length) return []
  const c = candidate(messageRowId)
  if (!c?.message_id) return []
  // The fixed categories and replies skip bulk mail; an inbox's own labels
  // (if it has any) look at bulk mail too.
  const ok = (k: AiJobKind): boolean =>
    k === 'labels' ? labelsEligible(c, now) && listAiLabels(c.account_id).length > 0 : classifyEligible(c, now)
  return kinds.filter((k) => ok(k) && enqueueAiJob(c.account_id, c.message_id as string, k, now))
}

export interface QueueDeps {
  ai: Ai
  /** Fetches a body that is not stored yet (ensureBody in main). */
  ensureBody: (accountId: number, messageRowId: number) => Promise<void>
  now?: () => number
}

type Handler = (deps: QueueDeps, rowId: number, now: number) => Promise<boolean>

const HANDLERS: Record<AiJobKind, Handler> = {
  classify: async (deps, rowId, now) => {
    const c = candidate(rowId)
    if (!c || !classifyEligible(c, now)) return false
    return classifyMessage(deps.ai, rowId)
  },
  // Re-checked here: classifyEligible let it into the queue, but robots,
  // mail not addressed to me and threads I answered get no suggestions.
  replies: async (deps, rowId, now) => {
    const c = candidate(rowId)
    if (!c || !repliesEligible(c, now, { fresh: true })) return false
    await suggestRepliesOnce(deps.ai, rowId, { background: true })
    return true
  },
  labels: async (deps, rowId, now) => {
    const c = candidate(rowId)
    if (!c || !labelsEligible(c, now)) return false
    return labelMessage(deps.ai, rowId)
  }
}

/** Works through due jobs, newest mail first. Returns what was done and why it stopped early, if it did. */
export async function runAiJobs(
  deps: QueueDeps,
  limit = 5
): Promise<{ done: { accountId: number; kind: AiJobKind }[]; stopped: AiErrorCode | null }> {
  const now = deps.now?.() ?? Date.now()
  expireAiJobs(now - FRESH_MS)
  pruneAiJobs(now - WEEK_MS)
  const done: { accountId: number; kind: AiJobKind }[] = []
  const due = dueAiJobs(now, limit)
  if (!due.length) return { done, stopped: null }
  const st = deps.ai.status()
  if (!st.hasKey[st.provider]) return { done, stopped: 'no-key' }
  refreshListRows()
  for (const job of due) {
    const stop = await runOne(deps, job, st.features[KIND_FEATURE[job.kind]], now)
    if (stop) return { done, stopped: stop }
    if (stop === null) done.push({ accountId: job.account_id, kind: job.kind })
  }
  return { done, stopped: null }
}

/** null = done; undefined = skipped or retried; a code = stop the run. */
async function runOne(deps: QueueDeps, job: AiJob, on: boolean, now: number): Promise<AiErrorCode | null | undefined> {
  const handler = HANDLERS[job.kind]
  if (!on) {
    finishAiJob(job.id, 'skipped', 'feature off')
    return undefined
  }
  const rowId = inboxCopyOf(job.account_id, job.message_id)
  if (!rowId) {
    finishAiJob(job.id, 'skipped', 'no longer in the Inbox')
    return undefined
  }
  try {
    // A body that cannot be fetched (reauth, expunged, timeout) is no reason to
    // fail: the classifier works from the stored snippet instead.
    await deps.ensureBody(job.account_id, rowId).catch(() => undefined)
    const ran = await handler(deps, rowId, now)
    finishAiJob(job.id, ran ? 'done' : 'skipped')
    return ran ? null : undefined
  } catch (e) {
    const code: AiErrorCode = e instanceof AiError ? e.code : 'failed'
    if (STOPPERS.has(code)) return code
    retryAiJob(job.id, e instanceof Error ? e.message : String(e), now)
    return undefined
  }
}
