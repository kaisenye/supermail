import { getDb } from '../store/db.js'
import { markDirtyByMessageId } from '../store/listRows.js'
import { getMessage } from '../store/repo.js'

interface ThreadTarget {
  rowId: number
  accountId: number
  /** The row's own Message-ID, or the thread's first one. */
  own: string
  /** Message-IDs of every message in the thread, for its account. */
  ids: string[]
}

/** One target per (account, thread); rows without any Message-ID are skipped. */
function threadTargets(rowIds: number[]): ThreadTarget[] {
  const db = getDb()
  const seen = new Set<string>()
  const out: ThreadTarget[] = []
  for (const rowId of rowIds) {
    const m = getMessage(rowId)
    if (!m) continue
    const key = `${m.account_id}\u0000${m.thread_id ?? `#${m.id}`}`
    if (seen.has(key)) continue
    seen.add(key)
    const ids = m.thread_id
      ? (
          db
            .prepare(
              'SELECT DISTINCT message_id FROM messages WHERE account_id = ? AND thread_id = ? AND message_id IS NOT NULL'
            )
            .all(m.account_id, m.thread_id) as { message_id: string }[]
        ).map((r) => r.message_id)
      : m.message_id
        ? [m.message_id]
        : []
    if (ids.length) out.push({ rowId, accountId: m.account_id, own: m.message_id ?? ids[0], ids })
  }
  return out
}

function isMuted(t: ThreadTarget): boolean {
  const holes = t.ids.map(() => '?').join(',')
  return !!getDb()
    .prepare(`SELECT 1 FROM mutes WHERE account_id = ? AND message_id IN (${holes}) LIMIT 1`)
    .get(t.accountId, ...t.ids)
}

function applyMute(targets: ThreadTarget[], mute: boolean, now: number): number[] {
  const db = getDb()
  const changed: number[] = []
  db.transaction(() => {
    for (const t of targets) {
      if (isMuted(t) === mute) continue
      if (mute) {
        db.prepare('INSERT OR IGNORE INTO mutes (account_id, message_id, created_at) VALUES (?, ?, ?)').run(
          t.accountId,
          t.own,
          now
        )
      } else {
        const holes = t.ids.map(() => '?').join(',')
        db.prepare(`DELETE FROM mutes WHERE account_id = ? AND message_id IN (${holes})`).run(
          t.accountId,
          ...t.ids
        )
      }
      for (const id of t.ids) markDirtyByMessageId(t.accountId, id)
      changed.push(t.rowId)
    }
  })()
  return changed
}

/**
 * Mute is a local rule: the thread, and any reply that arrives later, stays
 * out of the local Inbox (listRows hides it). Nothing moves on the server.
 *
 * Every target thread ends in one state: all muted, unless every one already
 * is, then all unmuted. Returns that state and the row ids whose thread
 * changed (so undo reverses exactly those), or null when no target has a
 * Message-ID.
 */
export function toggleMute(
  rowIds: number[],
  now = Date.now()
): { muted: boolean; changed: number[] } | null {
  const targets = threadTargets(rowIds)
  if (!targets.length) return null
  const muted = !targets.every(isMuted)
  return { muted, changed: applyMute(targets, muted, now) }
}

/** Sets the threads of `rowIds` muted or unmuted. Returns the row ids that changed. */
export function setMute(rowIds: number[], mute: boolean, now = Date.now()): number[] {
  return applyMute(threadTargets(rowIds), mute, now)
}

interface SenderTarget {
  rowId: number
  accountId: number
  address: string
}

/** One target per (account, sender address); rows without a sender are skipped. */
function senderTargets(rowIds: number[]): SenderTarget[] {
  const seen = new Set<string>()
  const out: SenderTarget[] = []
  for (const rowId of rowIds) {
    const m = getMessage(rowId)
    const address = m?.from_addr?.trim().toLowerCase()
    if (!m || !address) continue
    const key = `${m.account_id}\u0000${address}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ rowId, accountId: m.account_id, address })
  }
  return out
}

function isVip(t: SenderTarget): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM vip_senders WHERE account_id = ? AND address = ?')
    .get(t.accountId, t.address)
}

function applyVip(targets: SenderTarget[], vip: boolean): number[] {
  const db = getDb()
  const changed: number[] = []
  db.transaction(() => {
    for (const t of targets) {
      if (isVip(t) === vip) continue
      if (vip) db.prepare('INSERT INTO vip_senders (account_id, address) VALUES (?, ?)').run(t.accountId, t.address)
      else db.prepare('DELETE FROM vip_senders WHERE account_id = ? AND address = ?').run(t.accountId, t.address)
      changed.push(t.rowId)
    }
  })()
  return changed
}

/**
 * Marks the senders VIP (always Important, and the VIP split), or unmarks
 * them: all VIP, unless every one already is, then none. Returns that state
 * and the row ids whose sender changed, or null when no target has a sender.
 */
export function toggleVip(rowIds: number[]): { vip: boolean; changed: number[] } | null {
  const targets = senderTargets(rowIds)
  if (!targets.length) return null
  const vip = !targets.every(isVip)
  return { vip, changed: applyVip(targets, vip) }
}

/** Sets the senders of `rowIds` VIP or not. Returns the row ids that changed. */
export function setVip(rowIds: number[], vip: boolean): number[] {
  return applyVip(senderTargets(rowIds), vip)
}
