import type { AccountConfig } from '../accounts/config.js'
import { getPool } from '../sync/pool.js'
import { clearSnooze, listDueSnoozes, moveMessage, findFolderByPath } from '../store/repo.js'

/**
 * Returns snoozed mail to its original folder once its time arrives.
 *
 * The server has no concept of snooze, so the message physically lives in a
 * Snoozed mailbox and the row remembers where it came from. Waking is the
 * reverse move plus clearing the local marker.
 */

export const SNOOZE_PATH = 'Snoozed'

/** Creates the mailbox on first use; Exmail allows it (verified). */
export async function ensureSnoozeFolder(config: AccountConfig): Promise<void> {
  await getPool(config).withConnection(async (client) => {
    const boxes = await client.list()
    if (boxes.some((b) => b.path === SNOOZE_PATH)) return
    await client.mailboxCreate(SNOOZE_PATH)
  })
}

export interface WakeResult {
  woken: number
}

export async function wakeDueSnoozes(
  configFor: (accountId: number) => AccountConfig | null,
  now = Date.now()
): Promise<WakeResult> {
  const due = listDueSnoozes(now)
  let woken = 0

  for (const row of due) {
    const config = configFor(row.account_id)
    if (!config) continue
    const backTo = row.snooze_from ?? 'INBOX'
    const dest = findFolderByPath(row.account_id, backTo)
    if (!dest) {
      // The folder went away; drop the marker rather than retrying forever.
      clearSnooze(row.id)
      continue
    }

    try {
      if (row.uid !== null) {
        await getPool(config).withConnection(async (client) => {
          const lock = await client.getMailboxLock(SNOOZE_PATH)
          try {
            await client.messageMove(String(row.uid), backTo, { uid: true })
          } finally {
            lock.release()
          }
        })
      }
      // Local move mirrors the server so the list updates without a sync.
      moveMessage(row.id, dest.id)
      clearSnooze(row.id)
      woken++
    } catch (err) {
      // Leave wake_at set: the next tick retries rather than losing the message
      // in Snoozed with no marker to bring it back.
      console.error(`[snooze] wake failed for message ${row.id}:`, err)
    }
  }

  return { woken }
}

let timer: ReturnType<typeof setInterval> | null = null

/**
 * Ticks every 30s. Snooze targets are coarse (hours, tomorrow morning), so a
 * finer interval would buy nothing but wakeups.
 */
export function startSnoozeWorker(
  configFor: (accountId: number) => AccountConfig | null,
  onWake?: (n: number) => void,
  intervalMs = 30_000
): void {
  if (timer) return
  let running = false
  timer = setInterval(() => {
    if (running) return
    running = true
    void wakeDueSnoozes(configFor)
      .then((r) => {
        if (r.woken > 0) onWake?.(r.woken)
      })
      .catch((e) => console.error('[snooze] worker failed:', e))
      .finally(() => {
        running = false
      })
  }, intervalMs)
}

export function stopSnoozeWorker(): void {
  if (timer) clearInterval(timer)
  timer = null
}
