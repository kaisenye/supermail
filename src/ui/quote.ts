/** Gmail-style quoted reply body. Output is compose HTML, not sanitised mail. */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** "On Mon, Jan 5, 2026 at 9:04 AM, Ada <ada@x.com> wrote:" */
export function attributionLine(
  from: string | null,
  fromName: string | null,
  date: number | null
): string {
  const who = fromName?.trim() ? `${fromName.trim()} <${from ?? ''}>` : (from ?? 'someone')
  const d = date ? new Date(date) : null
  if (!d || Number.isNaN(d.getTime())) return `${who} wrote:`
  const when = d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
  return `On ${when}, ${who} wrote:`
}

export interface QuoteSource {
  from_addr: string | null
  from_name: string | null
  date: number | null
  body_text: string | null
  body_html: string | null
  subject?: string | null
  to_addrs?: string | null
}

/**
 * Reply body: an empty paragraph to type into, then the quoted original. The
 * original's HTML is trusted here only because it round-trips our own sanitiser.
 */
export function buildReplyBody(msg: QuoteSource): string {
  const inner = msg.body_html
    ? msg.body_html
    : escapeHtml(msg.body_text ?? '').replace(/\r?\n/g, '<br>')
  const attribution = escapeHtml(
    attributionLine(msg.from_addr, msg.from_name, msg.date)
  )
  return (
    '<p><br></p>' +
    `<div class="supermail-quote"><p>${attribution}</p>` +
    `<blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex">${inner}</blockquote></div>`
  )
}

/**
 * Forward body. Unlike a reply this keeps the original headers, because the
 * new recipient has no other way to see who sent it or when.
 */
export function buildForwardBody(msg: QuoteSource): string {
  const inner = msg.body_html
    ? msg.body_html
    : escapeHtml(msg.body_text ?? '').replace(/\r?\n/g, '<br>')
  const from = msg.from_name
    ? `${msg.from_name} <${msg.from_addr ?? ''}>`
    : (msg.from_addr ?? '(unknown)')
  const rows: string[] = [`<b>From:</b> ${escapeHtml(from)}`]
  if (msg.date) rows.push(`<b>Date:</b> ${escapeHtml(new Date(msg.date).toLocaleString())}`)
  if (msg.subject) rows.push(`<b>Subject:</b> ${escapeHtml(msg.subject)}`)
  if (msg.to_addrs) rows.push(`<b>To:</b> ${escapeHtml(msg.to_addrs)}`)

  return (
    '<p><br></p>' +
    '<div class="supermail-quote"><p>---------- Forwarded message ----------</p>' +
    `<p>${rows.join('<br>')}</p>${inner}</div>`
  )
}
