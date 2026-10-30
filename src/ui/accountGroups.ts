/**
 * Thread ids per owning account, first-seen order, each once. Read/unread
 * IPC takes one account per call, and in the unified view one selection can
 * span accounts whose thread ids collide.
 */
export function threadsByAccount(
  rows: { thread_id: string | null; account_id: number }[]
): Map<number, string[]> {
  const out = new Map<number, string[]>()
  for (const r of rows) {
    if (!r.thread_id) continue
    const list = out.get(r.account_id) ?? []
    if (!list.includes(r.thread_id)) list.push(r.thread_id)
    out.set(r.account_id, list)
  }
  return out
}
