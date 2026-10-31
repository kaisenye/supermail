import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { sanitizeEmailHtml } from './sanitize.js'

/** Whether the element holding `text` is folded away (inside a data-quoted block). */
function folded(html: string, text: string): boolean {
  const doc = new JSDOM(`<body>${html}</body>`).window.document
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.textContent?.includes(text)) return !!n.parentElement?.closest('[data-quoted]')
  }
  throw new Error(`"${text}" not in output`)
}

describe('quoted history is folded', () => {
  it('Exmail: the "---- Original ----" divider and everything after it', () => {
    const { html } = sanitizeEmailHtml(
      '<div>Thanks, see you Monday.</div><div><br></div>' +
        '<div><div>------------------&nbsp;Original&nbsp;------------------</div>' +
        '<div><div id="menu_sender"><b>From:</b> Bill</div><div><b>Date:</b> Thu</div></div>' +
        '<div>Earlier message text</div></div>' +
        '<div>Even older history</div>'
    )
    expect(folded(html, 'Thanks, see you Monday.')).toBe(false)
    expect(folded(html, 'Original')).toBe(true)
    expect(folded(html, 'Bill')).toBe(true)
    expect(folded(html, 'Earlier message text')).toBe(true)
    expect(folded(html, 'Even older history')).toBe(true)
  })

  it('Exmail with the divider in another spacing or language', () => {
    for (const divider of ['------------------ Original ------------------', '------------------ 原始邮件 ------------------', '-----Original Message-----']) {
      const { html } = sanitizeEmailHtml(`<p>My reply</p><p>${divider}</p><p>Old text</p>`)
      expect(folded(html, 'My reply')).toBe(false)
      expect(folded(html, 'Old text')).toBe(true)
    }
  })

  it('Exmail header block (From / Date / To) with no divider', () => {
    const { html } = sanitizeEmailHtml(
      '<div>Reply here</div><div><div id="x_menu_sender"><b>发件人:</b> A</div><div>Old body</div></div>'
    )
    expect(folded(html, 'Reply here')).toBe(false)
    expect(folded(html, 'A')).toBe(true)
    expect(folded(html, 'Old body')).toBe(true)
  })

  it('folds from the first divider when the history repeats', () => {
    const { html } = sanitizeEmailHtml(
      '<div>Newest</div><div>---------- Original ----------</div><div>Middle</div>' +
        '<div>---------- Original ----------</div><div>Oldest</div>'
    )
    expect(folded(html, 'Newest')).toBe(false)
    expect(folded(html, 'Middle')).toBe(true)
    expect(folded(html, 'Oldest')).toBe(true)
  })

  it('leaves a message with no history alone, even one mentioning "original"', () => {
    const { html } = sanitizeEmailHtml('<p>The original plan still works.</p><p>-- Bill</p>')
    expect(html).not.toContain('data-quoted')
  })

  it('still folds Gmail and Outlook history and blockquotes', () => {
    const gmail = sanitizeEmailHtml('<div>Hi</div><div class="gmail_quote">On Mon X wrote:<div>old</div></div>').html
    expect(folded(gmail, 'Hi')).toBe(false)
    expect(folded(gmail, 'old')).toBe(true)
    const outlook = sanitizeEmailHtml('<div>Hi</div><div id="divRplyFwdMsg">From: X</div><div>old</div>').html
    expect(folded(outlook, 'From: X')).toBe(true)
    const quote = sanitizeEmailHtml('<p>Hi</p><blockquote>old</blockquote>').html
    expect(folded(quote, 'old')).toBe(true)
  })
})
