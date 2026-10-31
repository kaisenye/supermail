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

/**
 * Compose-only markers: where the signature and the quoted original start.
 * supermail-* is the pre-rename spelling, still on drafts saved before it.
 */
export const COMPOSE_MARKERS = new Set(['sovo-signature', 'sovo-quote', 'supermail-signature', 'supermail-quote'])

/**
 * `keepMarkers` keeps the two compose marker classes on a <div> — and nothing
 * else — so a saved draft still knows where the signature and quote begin.
 * Pastes never keep them: a copied marker would plant a false stop mid-body.
 * Main strips them before the mail goes out (`stripComposeMarkers`).
 */
export function cleanPastedHtml(html: string, opts: { keepMarkers?: boolean } = {}): string {
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
              attr.name === 'alt')) ||
          (opts.keepMarkers === true &&
            child.tagName === 'DIV' &&
            attr.name === 'class' &&
            COMPOSE_MARKERS.has(attr.value))
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

/**
 * The first top-level block Write with AI must not touch: the signature or
 * quote marker, or — for a draft saved before markers survived — anything
 * holding a <blockquote>, so the quoted original is never rewritten.
 */
function aiStop(el: HTMLElement): Element | undefined {
  return [...el.children].find(
    (c) =>
      [...COMPOSE_MARKERS].some((m) => c.classList.contains(m)) ||
      c.tagName === 'BLOCKQUOTE' ||
      c.querySelector('blockquote') !== null
  )
}

/**
 * What Write with AI works on: the selection inside `el`, else everything the
 * user wrote — from the top down to the signature or the quoted original.
 *
 * The range ends INSIDE the last node above the stop, never at the element
 * boundary (el, k): Chromium's insertHTML over a range ending there merges
 * the next block's first line into the new text and can unwrap the signature.
 * Blank lines right above the stop are left alone. With nothing written above
 * them, the first blank line (the caret line of an empty new message) is the
 * target and the rest stay as the spacer. With only one blank line or none, the
 * range is collapsed at that spot in `el`; aiWriteRange adds the paragraph to
 * write into when the text arrives.
 *
 * Never edits the editor: opening the menu and cancelling leaves the body as it was.
 */
export function aiTargetRange(el: HTMLDivElement | null): Range | null {
  if (!el) return null
  const picked = captureSelection(el)
  if (picked) return picked
  const range = document.createRange()
  range.selectNodeContents(el)
  const stop = aiStop(el)
  if (!stop) return range
  // Blank lines just above the stop (the spacer App puts before the signature)
  // stay outside the range: insertHTML would delete them, and the AI text would
  // sit directly on the signature.
  let below: ChildNode = stop
  while (below.previousSibling && isBlankLine(below.previousSibling)) below = below.previousSibling
  const prev = below.previousSibling
  if (prev) {
    range.setEnd(prev, prev.nodeType === Node.TEXT_NODE ? (prev as Text).length : prev.childNodes.length)
  } else if (below !== stop && below.nextSibling !== stop && below.nodeType === Node.ELEMENT_NODE) {
    // Two or more blank lines and nothing above: write into the first one.
    range.setStart(below, 0)
    range.setEnd(below, 0)
  } else {
    const at = [...el.childNodes].indexOf(below)
    range.setStart(el, at)
    range.setEnd(el, at)
  }
  return range
}

/**
 * The range to insert Write with AI's text into. A range left collapsed at a
 * spot in `el` itself by aiTargetRange gets an empty paragraph there first, so
 * the text never lands on the line below. Call it only once the text is in hand.
 */
export function aiWriteRange(el: HTMLDivElement, range: Range): Range {
  if (!range.collapsed || range.startContainer !== el) return range
  const p = document.createElement('p')
  p.appendChild(document.createElement('br'))
  el.insertBefore(p, el.childNodes[range.startOffset] ?? null)
  const r = document.createRange()
  r.setStart(p, 0)
  r.setEnd(p, 0)
  return r
}

/** Whitespace text, or a paragraph/div holding nothing but <br>s and whitespace. */
function isBlankLine(n: Node): boolean {
  if (n.nodeType === Node.TEXT_NODE) return !/\S/.test(n.textContent ?? '')
  if (!(n instanceof HTMLElement) || (n.tagName !== 'P' && n.tagName !== 'DIV')) return false
  return !/\S/.test(n.textContent ?? '') && [...n.children].every((c) => c.tagName === 'BR')
}

/** The caret or selection inside `el`. captureSelection ignores a bare caret; a snippet goes exactly there. */
export function captureCaret(el: HTMLElement | null): Range | null {
  const sel = window.getSelection()
  if (!el || !sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  return el.contains(range.commonAncestorContainer) ? range.cloneRange() : null
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
