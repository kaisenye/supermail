import { randomBytes } from 'crypto'
import { basename } from 'path'

/**
 * RFC 822 builder for the Sent-folder APPEND. Single source of truth so the
 * stored copy matches what nodemailer put on the wire.
 */

export interface MimeAttachment {
  path: string
  filename: string
  contentType: string
  content: Buffer
}

/** An image referenced from the HTML as <img src="cid:contentId">. */
export interface MimeInlineImage {
  contentId: string
  filename: string
  contentType: string
  content: Buffer
}

export interface MimeInput {
  from: string
  to: string
  cc?: string | null
  subject: string
  text: string
  html?: string | null
  inReplyTo?: string | null
  references?: string | null
  messageId: string
  date?: Date
  attachments?: MimeAttachment[]
  inline?: MimeInlineImage[]
}

const CRLF = '\r\n'

function boundary(): string {
  return `----=_supermail_${randomBytes(12).toString('hex')}`
}

function isAscii(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[^\x00-\x7F]/.test(s)
}

/**
 * A newline in a header value would start a new header. Every value that
 * reaches the header block must pass through here first.
 */
function stripCrlf(value: string): string {
  return value.replace(/[\r\n]+/g, ' ')
}

/**
 * RFC 2047 encoded-word for header values. Splits on 30-byte UTF-8 chunks so
 * no encoded-word exceeds the 75-char limit and no character is split.
 */
export function encodeHeaderWord(value: string): string {
  const safe = stripCrlf(value)
  if (isAscii(safe)) return safe
  const bytes = Buffer.from(safe, 'utf8')
  const words: string[] = []
  let start = 0
  while (start < bytes.length) {
    let end = Math.min(start + 30, bytes.length)
    // Back off to a UTF-8 boundary: continuation bytes are 10xxxxxx.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    words.push(`=?UTF-8?B?${bytes.subarray(start, end).toString('base64')}?=`)
    start = end
  }
  return words.join(`${CRLF} `)
}

/**
 * An address list may mix ASCII addresses with non-ASCII display names; only
 * the display-name part may be encoded, never the addr-spec.
 */
export function encodeAddressList(value: string): string {
  const safe = stripCrlf(value)
  if (isAscii(safe)) return safe
  return splitAddresses(safe)
    .map((raw) => {
      const addr = raw.trim()
      const m = /^(.*?)\s*<([^>]*)>$/.exec(addr)
      if (!m) return addr
      const name = m[1].replace(/^"|"$/g, '')
      return name ? `${encodeHeaderWord(name)} <${m[2]}>` : `<${m[2]}>`
    })
    .join(', ')
}

/** Commas inside a quoted display name ("Doe, Jane") are not separators. */
function splitAddresses(value: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const ch of value) {
    if (ch === '"') quoted = !quoted
    if (ch === ',' && !quoted) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out
}

/** RFC 2045 quoted-printable, soft-wrapped at 76 columns. */
export function quotedPrintable(input: string): string {
  const bytes = Buffer.from(input.replace(/\r?\n/g, '\n'), 'utf8')
  let line = ''
  const out: string[] = []
  const push = (chunk: string): void => {
    if (line.length + chunk.length > 75) {
      out.push(`${line}=`)
      line = ''
    }
    line += chunk
  }
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b === 0x0a) {
      // Trailing whitespace before a break must be encoded to survive transit.
      if (line.endsWith(' ')) line = `${line.slice(0, -1)}=20`
      else if (line.endsWith('\t')) line = `${line.slice(0, -1)}=09`
      out.push(line)
      line = ''
      continue
    }
    const printable = b === 0x09 || (b >= 0x20 && b <= 0x7e && b !== 0x3d)
    push(printable ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`)
  }
  out.push(line)
  return out.join(CRLF)
}

function base64Lines(buf: Buffer): string {
  const b64 = buf.toString('base64')
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76))
  return lines.join(CRLF)
}

function part(contentType: string, body: string): string {
  return [
    `Content-Type: ${contentType}; charset=utf-8`,
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(body)
  ].join(CRLF)
}

/**
 * Inline image part. `Content-ID` is what `<img src="cid:...">` resolves
 * against, and `inline` disposition keeps it out of the attachment list.
 */
function inlinePart(img: MimeInlineImage): string {
  const cid = stripCrlf(img.contentId).replace(/[<>"\s]/g, '')
  const name = encodeHeaderWord(img.filename).replace(/["\\]/g, '_')
  const type = stripCrlf(img.contentType).replace(/[;"]/g, '_')
  return [
    `Content-Type: ${type}; name="${name}"`,
    'Content-Transfer-Encoding: base64',
    `Content-ID: <${cid}>`,
    `Content-Disposition: inline; filename="${name}"`,
    '',
    base64Lines(img.content)
  ].join(CRLF)
}

function attachmentPart(a: MimeAttachment): string {
  // A quote in the filename would close the parameter early and let the rest
  // of the name inject header lines.
  const name = encodeHeaderWord(a.filename || basename(a.path)).replace(
    /["\\]/g,
    '_'
  )
  const type = stripCrlf(a.contentType).replace(/[;"]/g, '_')
  return [
    `Content-Type: ${type}; name="${name}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${name}"`,
    '',
    base64Lines(a.content)
  ].join(CRLF)
}

function multipart(subtype: string, parts: string[]): { headers: string[]; body: string } {
  const b = boundary()
  const body = [
    ...parts.map((p) => `--${b}${CRLF}${p}`),
    `--${b}--`,
    ''
  ].join(CRLF)
  return { headers: [`Content-Type: multipart/${subtype}; boundary="${b}"`], body }
}

/** Full RFC822 message: multipart/alternative, wrapped in /mixed if attached. */
export function buildMime(input: MimeInput): string {
  const alt = input.html
    ? multipart('alternative', [part('text/plain', input.text), part('text/html', input.html)])
    : { headers: ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable'], body: quotedPrintable(input.text) }

  // Inline images wrap the alternative in /related, so the cid: references in
  // the HTML resolve against siblings rather than against real attachments.
  const inline = input.inline ?? []
  const related = inline.length
    ? multipart('related; type="multipart/alternative"', [
        [...alt.headers, '', alt.body].join(CRLF),
        ...inline.map(inlinePart)
      ])
    : alt

  const attachments = input.attachments ?? []
  const content = attachments.length
    ? multipart('mixed', [
        [...related.headers, '', related.body].join(CRLF),
        ...attachments.map(attachmentPart)
      ])
    : related

  const headers = [
    `From: ${encodeAddressList(input.from)}`,
    `To: ${encodeAddressList(input.to)}`,
    input.cc ? `Cc: ${encodeAddressList(input.cc)}` : null,
    `Subject: ${encodeHeaderWord(input.subject)}`,
    `Message-ID: ${stripCrlf(input.messageId)}`,
    `Date: ${(input.date ?? new Date()).toUTCString()}`,
    'MIME-Version: 1.0',
    input.inReplyTo ? `In-Reply-To: ${stripCrlf(input.inReplyTo)}` : null,
    input.references ? `References: ${stripCrlf(input.references)}` : null,
    ...content.headers
  ].filter((l): l is string => l !== null)

  return [...headers, '', content.body].join(CRLF)
}

/** Degrade compose HTML to a readable text/plain part — never send it empty. */
export function htmlToPlainText(html: string): string {
  // Marks a block boundary so an open+close pair collapses to a single break,
  // while a real <br>-made blank line still survives. Never occurs in mail text.
  const BLOCK = '\u0000'
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, `${BLOCK}- `)
    // Both edges break: contenteditable emits `line1<div>line2</div>`, where
    // line1 has no closing tag of its own to break on.
    .replace(/<\/?(p|div|li|tr|h[1-6]|blockquote)\b[^>]*>/gi, BLOCK)
    // Keep the destination: a text-only reader sees link text but no URL.
    .replace(
      /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, label: string) => {
        const text = label.replace(/<[^>]+>/g, '').trim()
        return !text || text === href ? href : `${text} (${href})`
      }
    )
    .replace(/<[^>]+>/g, '')
    .replace(new RegExp(`${BLOCK}[ \\t]*(?:${BLOCK})+`, 'g'), BLOCK)
    .replace(new RegExp(BLOCK, 'g'), '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
