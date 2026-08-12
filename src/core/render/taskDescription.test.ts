import { describe, expect, it } from 'vitest'
import { sanitizeEmailHtml } from './sanitize.js'

/**
 * Every construct the task editor can produce must survive sanitisation —
 * a stripped tag means the user's formatting silently vanishes on save.
 */
const cases: [string, string][] = [
  ['heading 1', '<h1>Title</h1>'],
  ['heading 2', '<h2>Title</h2>'],
  ['heading 3', '<h3>Title</h3>'],
  ['bold', '<b>bold</b>'],
  ['strong', '<strong>bold</strong>'],
  ['italic', '<i>italic</i>'],
  ['emphasis', '<em>italic</em>'],
  ['underline', '<u>under</u>'],
  ['strikethrough', '<s>gone</s>'],
  ['inline code', '<code>x = 1</code>'],
  ['code block', '<pre>line one\nline two</pre>'],
  ['blockquote', '<blockquote>quoted</blockquote>'],
  ['bullet list', '<ul><li>one</li><li>two</li></ul>'],
  ['numbered list', '<ol><li>one</li></ol>'],
  ['link', '<a href="https://linear.app">Linear</a>'],
  ['horizontal rule', '<hr>']
]

describe('task description sanitisation', () => {
  for (const [name, html] of cases) {
    it(`keeps ${name}`, () => {
      const out = sanitizeEmailHtml(html).html
      // The tag itself must survive, not just the text inside it.
      const tag = /^<(\w+)/.exec(html)?.[1]
      expect(out).toContain(`<${tag}`)
    })
  }

  it('keeps the href on a link', () => {
    expect(sanitizeEmailHtml('<a href="https://linear.app">x</a>').html).toContain(
      'https://linear.app'
    )
  })

  it('strips a script even inside allowed markup', () => {
    const out = sanitizeEmailHtml('<p>hi<script>alert(1)</script></p>').html
    expect(out).not.toContain('script')
    expect(out).toContain('hi')
  })

  it('drops javascript: hrefs', () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>').html
    expect(out).not.toContain('javascript:')
  })
})
