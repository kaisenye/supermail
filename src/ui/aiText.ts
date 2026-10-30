export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Model text → compose HTML: blank lines split paragraphs, single newlines become <br>. */
export function textToHtml(text: string): string {
  const paras = text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!paras.length) return '<p><br></p>'
  return paras.map((p) => `<p>${escapeHtml(p).replace(/\r?\n/g, '<br>')}</p>`).join('')
}

const BLOCKS = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'TR'
])

/**
 * Editor range → plain text for the model. `Range.toString()` only joins text
 * nodes, so `<p>a</p><p>b</p>` reads "ab"; this keeps a blank line between
 * blocks and a newline per `<br>`, which `textToHtml` turns back into the same shape.
 */
export function rangeText(range: Range): string {
  const box = document.createElement('div')
  box.appendChild(range.cloneContents())
  return nodeText(box)
}

export function nodeText(root: Node): string {
  let out = ''
  let pendingBreak = false
  const emit = (s: string): void => {
    if (pendingBreak) {
      out += '\n\n'
      pendingBreak = false
    }
    out += s
  }
  const walk = (n: Node): void => {
    if (n.nodeType === 3) {
      // Raw newlines in a text node are source formatting, not line breaks.
      const t = (n.textContent ?? '').replace(/ /g, ' ').replace(/[ \t]*\r?\n[ \t]*/g, ' ')
      if (!t) return
      // Whitespace between blocks (or at a line start) is not content.
      if (!t.trim() && (pendingBreak || !out || out.endsWith('\n'))) return
      emit(t)
      return
    }
    if (n.nodeType !== 1) return
    const el = n as Element
    if (el.tagName === 'BR') {
      // A block's trailing <br> is the placeholder that keeps an empty line open.
      const placeholder = !el.nextSibling && el.parentElement !== null && BLOCKS.has(el.parentElement.tagName)
      if (!placeholder) emit('\n')
      return
    }
    const block = BLOCKS.has(el.tagName)
    if (block && out) pendingBreak = true
    el.childNodes.forEach(walk)
    if (block && out) pendingBreak = true
  }
  root.childNodes.forEach(walk)
  return out.replace(/[ \t]+\n/g, '\n').trim()
}

/**
 * Keeps only the newest of overlapping async requests. `start()` returns a
 * check that turns false once a later `start()` or a `cancel()` happens, so a
 * reply that lands after the menu (or Compose) closed is dropped.
 */
export function latestOnly(): { start: () => () => boolean; cancel: () => void } {
  let seq = 0
  return {
    start: () => {
      const id = ++seq
      return () => id === seq
    },
    cancel: () => {
      seq++
    }
  }
}
