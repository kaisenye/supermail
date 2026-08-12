/**
 * Shared contenteditable helpers for the two places that author outbound HTML:
 * the compose body and the signature. Both feed the same send path, so both
 * must be sanitised the same way — this is the only guard on that HTML, since
 * the received-mail sanitiser never sees it.
 */

// Tags an editor may emit. Anything else is unwrapped to its text so pasted
// browser markup cannot smuggle script or layout in.
const PASTE_TAGS = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'DIV', 'EM', 'I', 'IMG', 'LI', 'OL', 'P', 'PRE',
  'SPAN', 'STRONG', 'U', 'UL'
])

/** Only these can appear in an href; javascript:/data: must never survive. */
export const SAFE_HREF = /^(https?:|mailto:)/i

/**
 * Image sources we allow. data: is how the editor holds a logo before send,
 * cid: is what it becomes on the wire. Anything else — including http(s) —
 * is dropped, so a pasted image cannot beacon the recipient.
 */
const SAFE_IMG_SRC = /^(data:image\/(png|jpeg|gif|webp);base64,|cid:)/i

/**
 * A newline inside a text node is whitespace to HTML, so a line the user
 * actually broke renders joined up. contenteditable and pasted plain text both
 * produce these — turn them into real <br> before anything else looks at it.
 */
function newlinesToBreaks(doc: Document): void {
  const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */)
  const targets: Text[] = []
  let n = walker.nextNode()
  while (n) {
    if (n.nodeValue && /\n/.test(n.nodeValue)) targets.push(n as Text)
    n = walker.nextNode()
  }

  for (const text of targets) {
    // <pre> means the newline is already significant; leave it alone.
    if (text.parentElement?.closest('pre')) continue
    const parts = text.nodeValue!.split('\n')
    const frag = doc.createDocumentFragment()
    parts.forEach((part, i) => {
      if (i > 0) frag.appendChild(doc.createElement('br'))
      if (part) frag.appendChild(doc.createTextNode(part))
    })
    text.replaceWith(frag)
  }
}

export function cleanPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script,style,meta,link,iframe,object,embed,form').forEach((n) =>
    n.remove()
  )
  newlinesToBreaks(doc)
  const walk = (node: Element): void => {
    for (const child of [...node.children]) {
      walk(child)
      if (!PASTE_TAGS.has(child.tagName)) {
        child.replaceWith(...child.childNodes)
        continue
      }
      for (const attr of [...child.attributes]) {
        const keep =
          (child.tagName === 'A' && attr.name === 'href' && SAFE_HREF.test(attr.value)) ||
          (child.tagName === 'IMG' &&
            ((attr.name === 'src' && SAFE_IMG_SRC.test(attr.value)) ||
              // Dimensions matter for a logo; both are numeric-only.
              ((attr.name === 'width' || attr.name === 'height') &&
                /^\d{1,4}$/.test(attr.value)) ||
              attr.name === 'alt'))
        if (!keep) child.removeAttribute(attr.name)
      }
      // An <img> whose src we just stripped would render as a broken icon.
      if (child.tagName === 'IMG' && !child.getAttribute('src')) child.remove()
    }
  }
  walk(doc.body)
  return doc.body.innerHTML
}

/**
 * Paste handler shared by both editors: HTML goes through the sanitiser,
 * plain text is inserted as-is. `onChange` receives the new innerHTML.
 */
export function handlePaste(
  e: React.ClipboardEvent<HTMLDivElement>,
  el: HTMLDivElement | null,
  onChange: (html: string) => void
): void {
  e.preventDefault()
  const html = e.clipboardData.getData('text/html')
  const text = e.clipboardData.getData('text/plain').trim()

  // Pasting a URL over selected text links that text instead of replacing it —
  // the single most common formatting action, and typing it out by hand is
  // three steps otherwise.
  const sel = window.getSelection()
  if (text && SAFE_HREF.test(text) && !/\s/.test(text) && sel && !sel.isCollapsed) {
    document.execCommand('createLink', false, text)
    if (el) onChange(el.innerHTML)
    return
  }

  if (html) document.execCommand('insertHTML', false, cleanPastedHtml(html))
  // A bare URL with nothing selected still becomes a link, just self-titled.
  else if (text && SAFE_HREF.test(text) && !/\s/.test(text)) {
    document.execCommand('insertHTML', false, `<a href="${escapeAttr(text)}">${escapeHtml(text)}</a>`)
  } else document.execCommand('insertText', false, text)
  if (el) onChange(el.innerHTML)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

/**
 * The selection to link, captured BEFORE anything can steal focus. Focusing
 * the link input collapses the editor's selection, so the caller must grab the
 * range first and hand it back — otherwise createLink has nothing to wrap.
 */
export function captureSelection(el: HTMLDivElement | null): Range | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  // Ignore a selection that lives outside this editor.
  if (el && !el.contains(range.commonAncestorContainer)) return null
  return range.cloneRange()
}

export type LinkResult = 'ok' | 'bad-url' | 'no-selection'

/**
 * Wraps `range` in a link. Returns why it failed rather than failing silently.
 */
export function applyLink(
  el: HTMLDivElement | null,
  range: Range | null,
  url: string,
  onChange: (html: string) => void
): LinkResult {
  const trimmed = url.trim()
  if (!SAFE_HREF.test(trimmed)) return 'bad-url'
  if (!range) return 'no-selection'

  el?.focus()
  const sel = window.getSelection()
  if (!sel) return 'no-selection'
  sel.removeAllRanges()
  sel.addRange(range)

  document.execCommand('createLink', false, trimmed)
  if (el) onChange(el.innerHTML)
  return 'ok'
}
