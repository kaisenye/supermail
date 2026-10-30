import { describe, expect, it } from 'vitest'
import { expandSnippet, shortcutBeforeCaret, snippetHtml, snippetVars } from './snippetVars.js'

const now = new Date(2026, 9, 29, 10, 0)

describe('snippet variables', () => {
  it('fills names from the first To recipient and from you', () => {
    const v = snippetVars({ to: 'Ann Marie Lee <ann@x.test>, bob@y.test', me: { name: 'Kai Ye', email: 'kai@z.test' }, now })
    expect(v).toMatchObject({
      first_name: 'Ann',
      last_name: 'Marie Lee',
      name: 'Ann Marie Lee',
      email: 'ann@x.test',
      my_name: 'Kai Ye',
      my_first_name: 'Kai',
      my_email: 'kai@z.test',
      date: now.toLocaleDateString()
    })
  })

  it('leaves unknown or empty variables visible instead of blank', () => {
    const v = snippetVars({ to: 'ann@x.test', me: { name: null, email: null }, now })
    expect(expandSnippet('Hi {first_name}, {EMAIL} {nope}', v)).toBe('Hi {first_name}, ann@x.test {nope}')
  })

  it('turns plain text into safe editor HTML', () => {
    expect(snippetHtml('a < b & c\nnext')).toBe('a &lt; b &amp; c<br>next')
  })

  it('finds a ;shortcut right before the caret, at a word start only', () => {
    expect(shortcutBeforeCaret(';thx')).toBe('thx')
    expect(shortcutBeforeCaret('Hello ;thx')).toBe('thx')
    // contenteditable types a no-break space before the caret.
    expect(shortcutBeforeCaret('Hello ;thx')).toBe('thx')
    expect(shortcutBeforeCaret('a;thx')).toBeNull()
    expect(shortcutBeforeCaret(';thx ')).toBeNull()
    expect(shortcutBeforeCaret('Hello')).toBeNull()
  })
})
