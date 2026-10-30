export interface SnippetContext {
  to: string
  me: { name: string | null; email: string | null }
  now: Date
}

function firstRecipient(to: string): { name: string; email: string } {
  const first = to.split(/[,;]/).map((s) => s.trim()).find(Boolean) ?? ''
  const m = /^(.*?)<([^>]+)>\s*$/.exec(first)
  const name = (m ? m[1] : '').trim().replace(/^"|"$/g, '').trim()
  return { name, email: (m ? m[2] : first).trim() }
}

/** The variables a snippet can use. Recipient ones read the first To address. */
export function snippetVars(ctx: SnippetContext): Record<string, string> {
  const r = firstRecipient(ctx.to)
  const [first = '', ...rest] = r.name.split(/\s+/).filter(Boolean)
  const myName = ctx.me.name?.trim() ?? ''
  return {
    first_name: first,
    last_name: rest.join(' '),
    name: r.name,
    email: r.email,
    my_name: myName,
    my_first_name: myName.split(/\s+/)[0] ?? '',
    my_email: ctx.me.email ?? '',
    date: ctx.now.toLocaleDateString(),
    day: ctx.now.toLocaleDateString(undefined, { weekday: 'long' })
  }
}

/** Replaces {variables}, any case. Unknown or empty ones stay as typed, so a missing name shows instead of a blank. */
export function expandSnippet(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key.toLowerCase()] || whole)
}

/** Plain snippet text as editor HTML: escaped, line breaks kept. */
export function snippetHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>')
}

/** The `;shortcut` just before the caret, when it starts a word. */
export function shortcutBeforeCaret(textBefore: string): string | null {
  const m = /(?:^|\s);([a-z0-9_-]{1,24})$/i.exec(textBefore)
  return m ? m[1] : null
}
