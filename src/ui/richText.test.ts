// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { aiTargetRange, aiWriteRange, cleanPastedHtml } from './richText.js'
import { buildReplyBody, signatureBlock } from './quote.js'
import { rangeText } from './aiText.js'

function editor(html: string): HTMLDivElement {
  const el = document.createElement('div')
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

/** What insertHTML would replace, as HTML. */
function covered(r: Range): string {
  const box = document.createElement('div')
  box.appendChild(r.cloneContents())
  return box.innerHTML
}

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

describe('Write with AI target range', () => {
  // Ending at the element boundary (el, k) made Chromium's insertHTML merge
  // the signature's first line into the AI text and unwrap the signature div.
  it('ends inside the last block above the signature, not at the editor boundary', () => {
    const el = editor('<p>Hello</p><p><br></p><div class="sovo-signature"><p>Kai</p><p>CEO</p></div>')
    const r = aiTargetRange(el)!
    expect(r.endContainer).toBe(el.childNodes[0])
    expect(r.endOffset).toBe(1)
    expect(r.endContainer).not.toBe(el)
    expect(covered(r)).not.toContain('Kai')
    expect(rangeText(r)).toBe('Hello')
  })

  // App puts `<p><br></p>` between the body and the signature; insertHTML over
  // a range that covers it deletes it, so the AI text sat right on the signature.
  it('leaves the blank spacer line above the signature outside the range', () => {
    const el = editor('<p>first line of my note</p><p><br></p>' + signatureBlock('Qa Tester'))
    const r = aiTargetRange(el)!
    expect(covered(r)).toBe('<p>first line of my note</p>')
    expect(r.endContainer).toBe(el.firstChild)
  })

  // An empty new message is a caret line plus App's spacer. Write with AI goes
  // into the caret line, so exactly one blank line stays above the signature,
  // as it does when the user has typed something.
  it('writes an empty new message into its caret line, keeping one blank line above the signature', () => {
    const html = '<p><br></p><p><br></p>' + signatureBlock('Qa Tester')
    const el = editor(html)
    const r = aiTargetRange(el)!
    expect(r.collapsed).toBe(true)
    expect(r.startContainer).toBe(el.children[0])
    expect(el.innerHTML).toBe(html)
    expect(aiWriteRange(el, r)).toBe(r)
    expect(el.innerHTML).toBe(html)
  })

  // Opening the menu and pressing Esc must leave the body as it was.
  it('never edits the editor just to pick the target', () => {
    for (const html of [
      '<p><br></p><p><br></p>' + signatureBlock('Qa Tester'),
      '<p><br></p>' + signatureBlock('Qa Tester'),
      signatureBlock('<p>Kai</p>'),
      '<p><br></p><div class="sovo-quote"><p>On Mon:</p><blockquote>q</blockquote></div>',
      ''
    ]) {
      const el = editor(html)
      aiTargetRange(el)
      aiTargetRange(el)
      expect(el.innerHTML).toBe(html)
    }
  })

  it('writes an empty reply into a new paragraph above its only blank line, added when the text arrives', () => {
    const el = editor('<p><br></p>' + signatureBlock('Qa Tester'))
    const r = aiTargetRange(el)!
    expect(r.collapsed).toBe(true)
    expect(el.children).toHaveLength(2)
    const w = aiWriteRange(el, r)
    expect(el.children).toHaveLength(3)
    expect(w.collapsed).toBe(true)
    expect(w.startContainer).toBe(el.children[0])
    expect(el.children[0].outerHTML).toBe('<p><br></p>')
    expect(el.children[1].outerHTML).toBe('<p><br></p>')
    expect(el.children[2].className).toBe('sovo-signature')
  })

  it('stops above a one-paragraph signature when a reply quote follows', () => {
    const body = '<p>Yes Friday works.</p>' + signatureBlock('<p>Kai</p>') +
      '<div class="sovo-quote"><p>On Mon, Ann wrote:</p><blockquote><p>Friday?</p></blockquote></div>'
    const el = editor(body)
    const r = aiTargetRange(el)!
    expect(r.endContainer).toBe(el.firstChild)
    expect(covered(r)).toBe('<p>Yes Friday works.</p>')
  })

  it('ends inside a bare top-level text line', () => {
    const el = editor('Hi Ann<div class="sovo-signature">Kai</div>')
    const r = aiTargetRange(el)!
    expect(r.endContainer).toBe(el.firstChild)
    expect(r.endOffset).toBe(6)
    expect(rangeText(r)).toBe('Hi Ann')
  })

  it('gives a signature-first editor an empty paragraph to write into, outside the signature', () => {
    const el = editor('<div class="sovo-signature"><p>Kai</p></div>')
    const r = aiWriteRange(el, aiTargetRange(el)!)
    expect(r.collapsed).toBe(true)
    const p = el.firstChild as HTMLElement
    expect(p.tagName).toBe('P')
    expect(r.startContainer).toBe(p)
    expect((el.childNodes[1] as HTMLElement).className).toBe('sovo-signature')
    expect(el.querySelector('.sovo-signature')!.contains(r.startContainer)).toBe(false)
  })

  it('never reaches into the quoted original of a draft saved without markers', () => {
    // How old drafts were stored: every class stripped, the blockquote kept.
    const stored = cleanPastedHtml('<p>Sounds good</p>' + buildReplyBody({
      from_addr: 'ann@x.com', from_name: 'Ann', date: null, body_text: 'Friday?', body_html: null
    }))
    expect(stored).not.toContain('sovo-quote')
    const el = editor(stored)
    const r = aiTargetRange(el)!
    expect(covered(r)).not.toContain('Friday?')
    expect(covered(r)).not.toContain('blockquote')
    expect(rangeText(r)).toContain('Sounds good')
  })

  it('still uses the selection when there is one', () => {
    const el = editor('<p>Fix teh word</p>' + signatureBlock('<p>Kai</p>'))
    const sel = document.createRange()
    sel.setStart(el.firstChild!.firstChild!, 4)
    sel.setEnd(el.firstChild!.firstChild!, 7)
    window.getSelection()!.addRange(sel)
    expect(aiTargetRange(el)!.toString()).toBe('teh')
  })
})

describe('compose markers through the sanitiser', () => {
  const body = '<p>Hi</p>' + signatureBlock('<p class="x">Kai</p>') +
    '<div class="sovo-quote"><p>On Mon:</p><blockquote style="margin:0">q</blockquote></div>'

  it('keeps only the two marker classes on a div when saving a draft', () => {
    const saved = cleanPastedHtml(body, { keepMarkers: true })
    expect(saved).toBe(
      '<p>Hi</p><div class="sovo-signature"><p>Kai</p></div>' +
        '<div class="sovo-quote"><p>On Mon:</p><blockquote>q</blockquote></div>'
    )
    expect(cleanPastedHtml('<p class="sovo-quote">x</p><div class="sovo-quote other">y</div>', { keepMarkers: true }))
      .toBe('<p>x</p><div>y</div>')
  })

  it('strips them from a paste', () => {
    expect(cleanPastedHtml(body)).not.toContain('sovo-')
  })

  it('a reopened draft still scopes Write with AI above the signature', () => {
    const el = editor(cleanPastedHtml(body, { keepMarkers: true }))
    expect(covered(aiTargetRange(el)!)).toBe('<p>Hi</p>')
  })
})

describe('cleanPastedHtml keepColors', () => {
  it('keeps a span color the editor set, and nothing else on it', () => {
    const out = cleanPastedHtml('<p><span style="color: rgb(220, 38, 38); font-size: 40px" onclick="x()">Hi</span></p>', {
      keepColors: true
    })
    expect(out).toBe('<p><span style="color: rgb(220, 38, 38)">Hi</span></p>')
  })

  it('drops a color that is not a plain value', () => {
    const out = cleanPastedHtml('<span style="color: var(--x)">a</span><span style="background: url(x)">b</span>', {
      keepColors: true
    })
    expect(out).toBe('<span>a</span><span>b</span>')
  })

  it('pastes still lose their colors', () => {
    expect(cleanPastedHtml('<span style="color: #dc2626">Hi</span>')).toBe('<span>Hi</span>')
  })
})
