/** A fixed chip, or a label picked in the sidebar (`label:<name>`, an AI category or an inbox label). */
export type ChipId = 'unread' | 'needsReply' | 'waiting' | 'starred' | `label:${string}`

export const labelChip = (name: string): ChipId => `label:${name}`

/** The label a sidebar chip filters on, or null for a fixed chip. */
export function chipLabel(chip: ChipId | null): string | null {
  return chip?.startsWith('label:') ? chip.slice('label:'.length) : null
}

/** Filter chips above the list (Scape). Each is a list-context query, so it also works as a split. */
export const CHIPS: { id: Exclude<ChipId, `label:${string}`>; label: string; query: string }[] = [
  { id: 'needsReply', label: 'Needs reply', query: 'is:needs-reply' },
  { id: 'waiting', label: 'Waiting', query: 'is:waiting' },
  { id: 'unread', label: 'Unread', query: 'is:unread' },
  { id: 'starred', label: 'Starred', query: 'is:starred' }
]

export function viewQuery(splitQuery: string, chip: ChipId | null): string {
  const label = chipLabel(chip)
  const chipQuery = label ? `ai:"${label}"` : (CHIPS.find((c) => c.id === chip)?.query ?? '')
  return [splitQuery.trim(), chipQuery].filter(Boolean).join(' ')
}
