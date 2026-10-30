import { getDb } from './db.js'
import { markDirtyByMessageId } from './listRows.js'

/** The classifier's verdict on one message (v21 ai_classifications). */
export interface Classification {
  important: boolean
  category: string
  /** One line, written to the user: why it is Important or Other. */
  reason: string
  model: string
}

/** Stores a verdict and marks the thread dirty, so its list rows re-read it. */
export function saveClassification(
  accountId: number,
  messageId: string,
  c: Classification,
  now = Date.now()
): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare(
      `INSERT INTO ai_classifications (account_id, message_id, important, category, reason, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, message_id) DO UPDATE SET
         important = excluded.important, category = excluded.category, reason = excluded.reason,
         model = excluded.model, created_at = excluded.created_at`
    ).run(accountId, messageId, c.important ? 1 : 0, c.category, c.reason, c.model, now)
    markDirtyByMessageId(accountId, messageId)
  })()
}

export function getClassification(accountId: number, messageId: string): Classification | null {
  const r = getDb()
    .prepare(
      'SELECT important, category, reason, model FROM ai_classifications WHERE account_id = ? AND message_id = ?'
    )
    .get(accountId, messageId) as
    | { important: number; category: string; reason: string; model: string }
    | undefined
  return r ? { important: r.important === 1, category: r.category, reason: r.reason, model: r.model } : null
}

/** Drops every verdict (the classifier was turned off): splits fall back to the heuristic at once. */
export function clearClassifications(): number {
  const db = getDb()
  return db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO list_dirty (account_id, thread_key)
       SELECT m.account_id, COALESCE(m.thread_id, '#' || m.id)
         FROM ai_classifications c
         JOIN messages m ON m.account_id = c.account_id AND m.message_id = c.message_id
        WHERE m.folder_id IS NOT NULL`
    ).run()
    return db.prepare('DELETE FROM ai_classifications').run().changes
  })()
}

export function saveReplyOptions(
  accountId: number,
  messageId: string,
  options: string[],
  model: string,
  now = Date.now()
): void {
  getDb()
    .prepare(
      `INSERT INTO reply_options (account_id, message_id, options, model, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id, message_id) DO UPDATE SET
         options = excluded.options, model = excluded.model, created_at = excluded.created_at`
    )
    .run(accountId, messageId, JSON.stringify(options), model, now)
}

export function getReplyOptions(accountId: number, messageId: string): string[] | null {
  const r = getDb()
    .prepare('SELECT options FROM reply_options WHERE account_id = ? AND message_id = ?')
    .get(accountId, messageId) as { options: string } | undefined
  if (!r) return null
  try {
    const v: unknown = JSON.parse(r.options)
    return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string') ? v : null
  } catch {
    return null
  }
}

/** The thread summary lives on its newest message, so a new reply makes it stale by itself. */
export function setSummary(messageRowId: number, summary: string | null): void {
  getDb().prepare('UPDATE messages SET summary = ? WHERE id = ?').run(summary, messageRowId)
}

// ---- background jobs ----

export type AiJobKind = 'classify' | 'replies'
export type AiJobStatus = 'pending' | 'done' | 'skipped' | 'expired' | 'failed'

export interface AiJob {
  id: number
  account_id: number
  message_id: string
  kind: AiJobKind
  attempts: number
  created_at: number
}

export const MAX_JOB_ATTEMPTS = 3

/** True when the job is new. A message is queued at most once per kind, ever. */
export function enqueueAiJob(accountId: number, messageId: string, kind: AiJobKind, now = Date.now()): boolean {
  return (
    getDb()
      .prepare('INSERT OR IGNORE INTO ai_jobs (account_id, message_id, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(accountId, messageId, kind, now).changes > 0
  )
}

/** Pending jobs that are due, newest mail first: fresh mail is what the user is about to read. */
export function dueAiJobs(now: number, limit: number): AiJob[] {
  return getDb()
    .prepare(
      `SELECT id, account_id, message_id, kind, attempts, created_at FROM ai_jobs
        WHERE status = 'pending' AND next_at <= ?
        ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(now, limit) as AiJob[]
}

export function finishAiJob(id: number, status: 'done' | 'skipped' | 'expired', error: string | null = null): void {
  getDb().prepare('UPDATE ai_jobs SET status = ?, error = ? WHERE id = ?').run(status, error, id)
}

/** Waits attempts² minutes before the next try; the third failure is final. */
export function retryAiJob(id: number, error: string, now: number): void {
  getDb()
    .prepare(
      `UPDATE ai_jobs SET attempts = attempts + 1, error = ?,
              next_at = ? + (attempts + 1) * (attempts + 1) * 60000,
              status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
        WHERE id = ?`
    )
    .run(error, now, MAX_JOB_ATTEMPTS, id)
}

/** Pending jobs queued before `before` are no longer worth the money. */
export function expireAiJobs(before: number): number {
  return getDb()
    .prepare("UPDATE ai_jobs SET status = 'expired' WHERE status = 'pending' AND created_at < ?")
    .run(before).changes
}

export function pruneAiJobs(before: number): number {
  return getDb().prepare("DELETE FROM ai_jobs WHERE status <> 'pending' AND created_at < ?").run(before).changes
}

// ---- usage ----

export interface AiUsageRecord {
  /** Local calendar day, YYYY-MM-DD. */
  day: string
  provider: string
  model: string
  feature: string
  inputTokens: number
  outputTokens: number
  costMicros: number
}

export function recordAiUsage(u: AiUsageRecord): void {
  getDb()
    .prepare(
      `INSERT INTO ai_usage (day, provider, model, feature, calls, input_tokens, output_tokens, cost_micros)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT (day, provider, model, feature) DO UPDATE SET
         calls = calls + 1,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cost_micros = cost_micros + excluded.cost_micros`
    )
    .run(u.day, u.provider, u.model, u.feature, u.inputTokens, u.outputTokens, u.costMicros)
}

/** Micro-dollars spent on `day`, across providers and features. */
export function spentMicros(day: string): number {
  return (
    getDb().prepare('SELECT COALESCE(SUM(cost_micros), 0) AS s FROM ai_usage WHERE day = ?').get(day) as {
      s: number
    }
  ).s
}
