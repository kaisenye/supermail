// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { escapeHtml, latestOnly, rangeText, textToHtml } from './aiText.js'
import { signatureBlock } from './quote.js'

describe('model text to compose HTML', () => {
  it('escapes markup and splits paragraphs on blank lines', () => {
    expect(escapeHtml('<b>&"')).toBe('&lt;b&gt;&amp;&quot;')
    expect(textToHtml('Hi Ann,\n\nYes <3\nSee you')).toBe('<p>Hi Ann,</p><p>Yes &lt;3<br>See you</p>')
    expect(textToHtml('  ')).toBe('<p><br></p>')
  })

  it('marks the signature so Write with AI stops above it', () => {
    expect(signatureBlock('<p>Kai</p>')).toBe('<div class="sovo-signature"><p>Kai</p></div>')
  })
})

describe('editor range to model text', () => {
  const textOf = (html: string): string => {
    const el = document.createElement('div')
    el.innerHTML = html
    document.body.appendChild(el)
    const r = document.createRange()
    r.selectNodeContents(el)
    const t = rangeText(r)
    el.remove()
    return t
  }

  it('keeps paragraph and line breaks that Range.toString() drops', () => {
    const html = '<p>Hi Ann,</p><p>Thanks for teh deck.<br>See you</p>'
    expect(textOf(html)).toBe('Hi Ann,\n\nThanks for teh deck.\nSee you')
    // The round trip back to HTML gives the same paragraphs.
    expect(textToHtml(textOf(html))).toBe('<p>Hi Ann,</p><p>Thanks for teh deck.<br>See you</p>')
  })

  it('reads Chromium div lines, blank lines and list items as separate blocks', () => {
    expect(textOf('Hi<div>Line two</div><div><br></div><div>Bye</div>')).toBe('Hi\n\nLine two\n\nBye')
    expect(textOf('<ul><li>one</li><li>two</li></ul><blockquote>q</blockquote>')).toBe('one\n\ntwo\n\nq')
  })

  it('keeps inline spacing but not source newlines or nbsp', () => {
    expect(textOf('<p>Hi <b>Ann</b> <i>there</i>&nbsp;now</p>\n  <p>next\nline</p>')).toBe('Hi Ann there now\n\nnext line')
  })

  it('reads only the selected part of the editor', () => {
    const el = document.createElement('div')
    el.innerHTML = '<p>Keep this</p><p>Fix teh</p><p>spelling</p>'
    document.body.appendChild(el)
    const r = document.createRange()
    r.setStart(el.childNodes[1].firstChild!, 4)
    r.setEnd(el.childNodes[2].firstChild!, 8)
    expect(rangeText(r)).toBe('teh\n\nspelling')
    el.remove()
  })
})

describe('latest-only request gate', () => {
  it('drops a reply once the menu closes', () => {
    const gate = latestOnly()
    const current = gate.start()
    expect(current()).toBe(true)
    gate.cancel()
    expect(current()).toBe(false)
  })

  it('drops the older of two overlapping requests', () => {
    const gate = latestOnly()
    const first = gate.start()
    const second = gate.start()
    expect(first()).toBe(false)
    expect(second()).toBe(true)
  })
})
