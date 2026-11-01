import type { MessageListRow } from '../core/store/types'
import { gmailChip, labelChip, type ChipId } from './chips'

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
  /** A Gmail label's own colour (labelInk), which overrides the tone's. */
  color?: string
}

/** Gmail label colours by label name, as Gmail defines them. */
export type LabelColors = Record<string, { bg: string; fg: string }>

function chroma(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return Math.max(...c) - Math.min(...c)
}

/**
 * The one colour a Gmail label pair stands for: of its background and text,
 * the more colourful (Gmail pairs a hue with white, black or a tint of
 * itself). Undefined for a grey pair, which keeps the neutral chip.
 */
export function labelInk(c: { bg: string; fg: string } | undefined): string | undefined {
  if (!c) return undefined
  const ink = chroma(c.bg) >= chroma(c.fg) ? c.bg : c.fg
  return chroma(ink) < 40 ? undefined : ink
}

export function categoryName(category: string): string {
  return AI_CATEGORY_NAMES.find((n) => n.toLowerCase() === category.toLowerCase()) ?? category
}

/**
 * Scape's row chips: Important when the classifier said so, then the category
 * ("Other" says nothing, so it is left out), then the inbox's own labels, then
 * its Gmail labels. A name already shown is not repeated.
 */
export function rowChips(
  r: Pick<MessageListRow, 'ai_important' | 'ai_category' | 'ai_labels' | 'server_labels'>,
  colors: LabelColors = {}
): LabelChipView[] {
  const chips: LabelChipView[] = []
  if (r.ai_important === 1) chips.push({ name: 'Important', tone: 'important' })
  const cat = r.ai_category?.toLowerCase()
  if (cat && cat !== 'other') chips.push({ name: categoryName(cat), tone: cat as ChipTone })
  const seen = new Set(chips.map((c) => c.name.toLowerCase()))
  for (const name of [...(r.ai_labels?.split(',') ?? []), ...(r.server_labels?.split(',') ?? [])]) {
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    const color = labelInk(colors[name])
    chips.push(color ? { name, tone: 'label', color } : { name, tone: 'label' })
  }
  return chips
}

/** One row of the sidebar's Labels: what it shows and the chip it filters on. */
export interface SidebarLabel extends LabelChipView {
  chip: ChipId
}

/**
 * The labels every inbox has: Important, then each AI category in the
 * classifier's order. Other is left out: it says nothing about the mail.
 */
export const DEFAULT_SIDEBAR_LABELS: SidebarLabel[] = [
  { name: 'Important', tone: 'important', chip: labelChip('Important') },
  ...AI_CATEGORY_NAMES.filter((n) => n !== 'Other').map((n) => ({
    name: n,
    tone: n.toLowerCase() as ChipTone,
    chip: labelChip(n)
  }))
]

/** The inbox's own labels for the sidebar: the mail server's (Gmail) first, then the ones defined in Settings → AI. */
export function yourSidebarLabels(r: { provider: string[]; own: string[]; colors?: LabelColors }): SidebarLabel[] {
  const reserved = new Set(DEFAULT_SIDEBAR_LABELS.map((l) => l.name.toLowerCase()))
  return [
    ...r.provider.map((n) => {
      const color = labelInk(r.colors?.[n])
      return { name: n, tone: 'label' as const, chip: gmailChip(n), ...(color ? { color } : {}) }
    }),
    ...r.own.filter((n) => !reserved.has(n.toLowerCase())).map((n) => ({ name: n, tone: 'label' as const, chip: labelChip(n) }))
  ]
}
