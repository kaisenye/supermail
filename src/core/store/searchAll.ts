import type { MessageListRow } from './types.js'

/**
 * Search results from each account, as one list. One account keeps its
 * relevance order; several are merged newest first, since bm25 scores from
 * separate queries do not compare.
 */
export function mergeByDate(lists: MessageListRow[][], limit: number): MessageListRow[] {
  const nonEmpty = lists.filter((l) => l.length)
  if (nonEmpty.length <= 1) return (nonEmpty[0] ?? []).slice(0, limit)
  return nonEmpty
    .flat()
    .sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
    .slice(0, limit)
}
