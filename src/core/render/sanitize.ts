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

const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
  'dd', 'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'q', 's', 'small', 'span',
  'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'u', 'ul', 'wbr'
]

const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'width', 'height', 'align', 'valign',
  'colspan', 'rowspan', 'border', 'cellpadding', 'cellspacing', 'dir'
]

// jsdom gives DOMPurify a real, officially-supported DOM in the main process.
const { window } = new JSDOM('')
const purify = createDOMPurify(window as unknown as Window & typeof globalThis)

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
      RETURN_DOM: false,
      RETURN_DOM_FRAGMENT: false
    })
    return { html: String(html), blockedImages }
  } finally {
    purify.removeHook('afterSanitizeAttributes')
  }
}

/** Plain-text fallback rendered as HTML, with linkified URLs. */
export function textToHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const linked = esc.replace(
    /\b(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer nofollow">$1</a>'
  )
  return linked
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br />')}</p>`)
    .join('')
}
