import { getDb } from '../store/db.js'

/**
 * Exmail files the Sent copy ~1.3 s after SMTP returns; the measured worst case
 * was well under 15 s. Past that, the 60 s background sync is the safety net.
 */
export const SENT_POLL_ATTEMPTS = 12
export const SENT_POLL_INTERVAL_MS = 1_500

export interface SentWaitDeps {
  /** One refresh of the Sent folder. Resolves to how many rows it stored. */
  poll: () => Promise<number>
  /** True once this send's own copy is in the local Sent folder. */
  stored: () => boolean
  sleep?: (ms: number) => Promise<void>
  attempts?: number
  intervalMs?: number
}

/**
 * Polls until this send's copy is local. Rows stored by a poll do not end the
 * wait: with two quick sends they can be the other send's copy.
 */
export async function waitForSentCopy(d: SentWaitDeps): Promise<boolean> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const attempts = d.attempts ?? SENT_POLL_ATTEMPTS
  for (let i = 0; i < attempts; i++) {
    if (d.stored()) return true
    await d.poll()
    if (d.stored()) return true
    if (i < attempts - 1) await sleep(d.intervalMs ?? SENT_POLL_INTERVAL_MS)
  }
  return false
}

export function hasSentCopy(accountId: number, folderId: number, messageId: string): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM messages WHERE account_id = ? AND folder_id = ? AND message_id = ? LIMIT 1')
    .get(accountId, folderId, messageId)
}

/**
 * Runs tasks for one key one at a time, in call order; different keys run
 * side by side. Two Sent refreshes on one account would otherwise read the
 * same last_uid and race to store the same rows.
 */
export function serialPerKey(): <T>(key: number, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<number, Promise<unknown>>()
  return <T>(key: number, task: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(task)
    tails.set(key, next)
    next
      .finally(() => {
        if (tails.get(key) === next) tails.delete(key)
      })
      .catch(() => {})
    return next
  }
}
