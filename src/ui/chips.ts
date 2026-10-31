export type ChipId = 'unread' | 'needsReply' | 'waiting' | 'starred'

/** Filter chips above the list (Scape). Each is a list-context query, so it also works as a split. */
export const CHIPS: { id: ChipId; label: string; query: string }[] = [
  { id: 'needsReply', label: 'Needs reply', query: 'is:needs-reply' },
  { id: 'waiting', label: 'Waiting', query: 'is:waiting' },
  { id: 'unread', label: 'Unread', query: 'is:unread' },
  { id: 'starred', label: 'Starred', query: 'is:starred' }
]

export function viewQuery(splitQuery: string, chip: ChipId | null): string {
  const chipQuery = CHIPS.find((c) => c.id === chip)?.query ?? ''
  return [splitQuery.trim(), chipQuery].filter(Boolean).join(' ')
}
