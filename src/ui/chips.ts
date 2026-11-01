/**
 * A fixed chip, or a label picked in the sidebar: `label:<name>` (Important,
 * an AI category or one of the inbox's own labels) or `gmail:<name>` (a label
 * on the mail server).
 */
export type ChipId = 'unread' | 'needsReply' | 'waiting' | 'starred' | `label:${string}` | `gmail:${string}`

export const labelChip = (name: string): ChipId => `label:${name}`
export const gmailChip = (name: string): ChipId => `gmail:${name}`

/** The label a sidebar chip filters on, or null for a fixed chip. */
export function chipLabel(chip: ChipId | null): string | null {
  if (chip?.startsWith('label:')) return chip.slice('label:'.length)
  if (chip?.startsWith('gmail:')) return chip.slice('gmail:'.length)
  return null
}

/** Filter chips above the list (Scape). Each is a list-context query, so it also works as a split. */
export const CHIPS: { id: Exclude<ChipId, `label:${string}` | `gmail:${string}`>; label: string; query: string }[] = [
  { id: 'needsReply', label: 'Needs reply', query: 'is:needs-reply' },
  { id: 'waiting', label: 'Waiting', query: 'is:waiting' },
  { id: 'unread', label: 'Unread', query: 'is:unread' },
  { id: 'starred', label: 'Starred', query: 'is:starred' }
]

function chipQuery(chip: ChipId | null): string {
  const name = chipLabel(chip)
  if (name === null) return CHIPS.find((c) => c.id === chip)?.query ?? ''
  if (chip!.startsWith('gmail:')) return `label:"${name}"`
  // Important is the classifier's verdict (and VIPs), not a category.
  return name.toLowerCase() === 'important' ? 'is:important' : `ai:"${name}"`
}

export function viewQuery(splitQuery: string, chip: ChipId | null): string {
  return [splitQuery.trim(), chipQuery(chip)].filter(Boolean).join(' ')
}
