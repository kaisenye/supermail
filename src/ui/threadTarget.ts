import type { MessageListRow } from '../core/store/types'

/**
 * Which list row and which ids a triage key pressed inside the open thread
 * acts on. Never the cursor: a sync that brings a new reply re-sorts the
 * thread's row and changes its id, while setRows keeps the cursor by index,
 * so the cursor can be on another conversation entirely.
 *
 * Looks the row up by message id, then by thread id within the open thread's
 * account: thread ids collide across accounts (same mailing list), so in All
 * inboxes a bare thread-id match can land on the other account's row. If
 * neither finds it, the open message's own id is still enough: planMoves
 * expands it to the whole thread in that folder.
 */
export function openThreadTarget(
  rows: Pick<MessageListRow, 'id' | 'thread_id' | 'account_id'>[],
  ot: { threadId: string; messageId: number; accountId?: number }
): { index: number; ids: number[] } {
  let index = rows.findIndex((r) => r.id === ot.messageId)
  if (index < 0 && ot.threadId)
    index = rows.findIndex(
      (r) => r.thread_id === ot.threadId && (ot.accountId == null || r.account_id === ot.accountId)
    )
  return { index, ids: index >= 0 ? [rows[index].id] : [ot.messageId] }
}
