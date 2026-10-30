import type { MessageListRow } from '../core/store/types'

/**
 * Which list row and which ids a triage key pressed inside the open thread
 * acts on. Never the cursor: a sync that brings a new reply re-sorts the
 * thread's row and changes its id, while setRows keeps the cursor by index,
 * so the cursor can be on another conversation entirely.
 *
 * Looks the row up by message id, then by thread id. If neither finds it, the
 * open message's own id is still enough: planMoves expands it to the whole
 * thread in that folder.
 */
export function openThreadTarget(
  rows: Pick<MessageListRow, 'id' | 'thread_id'>[],
  ot: { threadId: string; messageId: number }
): { index: number; ids: number[] } {
  let index = rows.findIndex((r) => r.id === ot.messageId)
  if (index < 0 && ot.threadId) index = rows.findIndex((r) => r.thread_id === ot.threadId)
  return { index, ids: index >= 0 ? [rows[index].id] : [ot.messageId] }
}
