/** The "/" menu in the notes editor (Linear): every block type, filterable. */

export interface SlashItem {
  id: string
  label: string
  /** Extra words that match: shorthands and the markdown that does the same. */
  keywords: string
  /** Markdown shorthand shown as a hint. */
  hint: string
}

export const SLASH_ITEMS: SlashItem[] = [
  { id: 'p', label: 'Text', keywords: 'paragraph plain body', hint: '' },
  { id: 'h1', label: 'Heading 1', keywords: 'h1 title big', hint: '#' },
  { id: 'h2', label: 'Heading 2', keywords: 'h2 subtitle', hint: '##' },
  { id: 'h3', label: 'Heading 3', keywords: 'h3 small', hint: '###' },
  { id: 'ul', label: 'Bulleted list', keywords: 'bullet unordered ul', hint: '-' },
  { id: 'ol', label: 'Numbered list', keywords: 'numbered ordered ol', hint: '1.' },
  { id: 'quote', label: 'Quote', keywords: 'blockquote citation', hint: '>' },
  { id: 'code', label: 'Code block', keywords: 'pre monospace snippet', hint: '```' },
  { id: 'hr', label: 'Divider', keywords: 'hr rule line separator', hint: '---' }
]

/**
 * The query after a "/" that starts a line or follows a space, or null when no
 * menu should show: "and/or", URLs and dates keep their slash.
 */
export function slashQuery(textBeforeCaret: string): string | null {
  const m = /(?:^|\s)\/([a-z0-9 ]{0,16})$/i.exec(textBeforeCaret)
  return m ? m[1] : null
}

export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return SLASH_ITEMS
  const words = q.split(/\s+/)
  return SLASH_ITEMS.filter((i) => {
    const hay = `${i.label} ${i.keywords}`.toLowerCase()
    return words.every((w) => hay.split(/\s+/).some((h) => h.startsWith(w)))
  })
}
