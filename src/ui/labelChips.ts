import type { MessageListRow } from '../core/store/types'

/**
 * The classifier's categories (src/core/ai/classify.ts AI_CATEGORIES), in its
 * order, as the UI names them. The renderer may not import classify.ts, so a
 * test keeps the two in step.
 */
export const AI_CATEGORY_NAMES = [
  'Personal',
  'Work',
  'Billing',
  'Notification',
  'Marketing',
  'Newsletter',
  'Calendar',
  'Support',
  'Other'
] as const

/** A chip's colour: Important, one per category, or `label` for an inbox's own labels. */
export type ChipTone = 'important' | 'label' | Lowercase<(typeof AI_CATEGORY_NAMES)[number]>

export interface LabelChipView {
  name: string
  tone: ChipTone
}

/** A row shows at most this many chips, so the subject keeps its room. */
export const MAX_ROW_CHIPS = 3

export function categoryName(category: string): string {
  return AI_CATEGORY_NAMES.find((n) => n.toLowerCase() === category.toLowerCase()) ?? category
}

/**
 * Scape's row chips: Important when the classifier said so, then the category
 * ("Other" says nothing, so it is left out), then the inbox's own labels.
 */
export function rowChips(r: Pick<MessageListRow, 'ai_important' | 'ai_category' | 'ai_labels'>): LabelChipView[] {
  const chips: LabelChipView[] = []
  if (r.ai_important === 1) chips.push({ name: 'Important', tone: 'important' })
  const cat = r.ai_category?.toLowerCase()
  if (cat && cat !== 'other') chips.push({ name: categoryName(cat), tone: cat as ChipTone })
  const seen = new Set(chips.map((c) => c.name.toLowerCase()))
  for (const name of r.ai_labels?.split(',') ?? []) {
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    chips.push({ name, tone: 'label' })
  }
  return chips.slice(0, MAX_ROW_CHIPS)
}
