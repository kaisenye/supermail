import createDOMPurify from 'dompurify'
import { JSDOM } from 'jsdom'

/**
 * Email HTML sanitiser.
 *
 * Email is hostile input: scripts, tracking pixels, and CSS that escapes its
 * container are all routine. DOMPurify does the parsing and stripping — a
 * real HTML parser, not regex, so mutation-XSS classes are covered. This
 * module adds the mail-specific policy on top:
 *
 *   - remote images are neutered by default (loading one tells the sender you
 *     opened the message)
 *   - links are hardened and forced external
 *
 * Runs in the main process, so the renderer never touches raw email HTML.
 * The opaque iframe sandbox and its CSP are the layers behind this one.
 */

export interface SanitizeResult {
  html: string
  blockedImages: number
}

/** Marks trailing quoted history so the renderer can collapse it. */
const QUOTE_ATTR = 'data-quoted'

// Client wrappers that are themselves the quoted history. class/id are not in
// ALLOWED_ATTR, so these are matched in uponSanitizeElement, before stripping.
const QUOTE_CLASS_ID =
  /^(gmail_quote(_container)?|divRplyFwdMsg|OutlookMessageHeader|moz-cite-prefix|appendonsend|yahoo_quoted|protonmail_quote)$/i

function isQuoteWrapper(node: Element): boolean {
  const id = node.getAttribute?.('id')
  if (id && QUOTE_CLASS_ID.test(id)) return true
  const cls = node.getAttribute?.('class')
  return !!cls && cls.split(/\s+/).some((c) => QUOTE_CLASS_ID.test(c))
}

const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
  'dd', 'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'q', 's', 'small', 'span',
  'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'u', 'ul', 'wbr'
]

const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'width', 'height', 'align', 'valign',
  'colspan', 'rowspan', 'border', 'cellpadding', 'cellspacing', 'dir',
  // Set by us only; the hook strips any inbound copy before we mark. Needed
  // in the allowlist because ALLOW_DATA_ATTR is false.
  QUOTE_ATTR
]

// jsdom gives DOMPurify a real, officially-supported DOM in the main process.
const { window } = new JSDOM('')
const purify = createDOMPurify(window as unknown as Window & typeof globalThis)

/**
 * Marks quoted history in an already-sanitised fragment. Only outermost nodes
 * are marked — nesting a marker inside a marked quote buys the UI nothing.
 */
function markQuotedBlocks(root: Element): void {
  for (const el of root.querySelectorAll(`blockquote,[${QUOTE_ATTR}]`)) {
    if (el.parentElement?.closest(`[${QUOTE_ATTR}]`)) el.removeAttribute(QUOTE_ATTR)
    else el.setAttribute(QUOTE_ATTR, '')
  }

  // Outlook separates the reply with an <hr>; everything after it is history.
  const hr = root.querySelector(':scope > hr')
  if (hr) {
    for (let n = hr as Element | null; n; n = n.nextElementSibling) {
      if (!n.closest(`[${QUOTE_ATTR}]`)) n.setAttribute(QUOTE_ATTR, '')
    }
  }
}

export function sanitizeEmailHtml(
  input: string,
  opts: { allowRemoteImages?: boolean } = {}
): SanitizeResult {
  let blockedImages = 0

  const hook = (node: Element): void => {
    const tag = node.tagName?.toLowerCase()

    if (tag === 'img') {
      const src = node.getAttribute('src')
      if (src) {
        if (/^data:/i.test(src)) {
          // data: image URIs can carry SVG with inline event handlers — an
          // XSS vector even after tag sanitisation. Drop them outright.
          node.removeAttribute('src')
        } else if (/^https?:/i.test(src) && !opts.allowRemoteImages) {
          // Keep the element (layout) but drop the request. data-blocked-src
          // lets the UI offer "load images" without refetching the message.
          blockedImages++
          node.removeAttribute('src')
          node.setAttribute('data-blocked-src', src)
        }
      }
    }

    if (tag === 'a' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer nofollow')
    }
  }

  // Runs before attributes are stripped, so class/id are still readable here.
  const elementHook = (node: Element): void => {
    node.removeAttribute?.(QUOTE_ATTR)
    if (isQuoteWrapper(node)) node.setAttribute(QUOTE_ATTR, '')
  }

  purify.addHook('uponSanitizeElement', elementHook as never)
  purify.addHook('afterSanitizeAttributes', hook as never)
  try {
    const html = purify.sanitize(input, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      // Drop these entirely, contents included.
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta'],
      FORBID_ATTR: ['style'],
      ALLOW_DATA_ATTR: false,
      // NB: ALLOWED_URI_REGEXP is deliberately NOT set — DOMPurify applies it
      // to every attribute, not just URIs, so it silently drops colspan/width.
      // Default scheme filtering already blocks javascript:/vbscript:; cid: is
      // whitelisted via the hook below.
      ADD_URI_SAFE_ATTR: ['cid'],
      KEEP_CONTENT: true,
      WHOLE_DOCUMENT: false,
      // Mark quotes on the sanitised tree, so the marker can never come from
      // the sender and structural detection sees the final shape.
      RETURN_DOM: true,
      RETURN_DOM_FRAGMENT: false
    }) as unknown as Element
    markQuotedBlocks(html)
    return { html: html.innerHTML, blockedImages }
  } finally {
    purify.removeHook('uponSanitizeElement')
    purify.removeHook('afterSanitizeAttributes')
  }
}

// An attribution line ("On <date>, X wrote:") or the first `>` quote line —
// whichever comes first starts the trailing history.
const ATTRIBUTION_RE = /^\s*(On\b.*\bwrote:\s*|-{2,}\s*Original Message\s*-{2,}|_{5,})\s*$/i

/** Index of the first line that begins the quoted history, or -1. */
function quoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (ATTRIBUTION_RE.test(lines[i])) return i
    if (/^\s*>/.test(lines[i])) return i
  }
  return -1
}

/** Plain-text fallback rendered as HTML, with linkified URLs. */
export function textToHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const linked = esc.replace(
    /\b(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer nofollow">$1</a>'
  )
  // Escaping turned `>` into `&gt;`, so split before deciding where quotes start.
  const lines = linked.split('\n')
  const at = quoteStart(lines.map((l) => l.replace(/&gt;/g, '>')))
  const toHtml = (src: string): string =>
    src
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .map((p) => `<p>${p.replace(/\n/g, '<br />')}</p>`)
      .join('')

  if (at < 0) return toHtml(linked)
  return (
    toHtml(lines.slice(0, at).join('\n')) +
    `<div ${QUOTE_ATTR}>${toHtml(lines.slice(at).join('\n'))}</div>`
  )
}
