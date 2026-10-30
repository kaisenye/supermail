import { describe, expect, it } from 'vitest'
import { asData, messageText, stripQuoted, transcript } from './mailText.js'

describe('mail text for prompts', () => {
  it('drops quoted history and attribution lines', () => {
    const t = 'Sounds good.\n\nOn Mon, Oct 27, 2026 at 9:00 AM Bob <b@x.test> wrote:\n> old text\n> more'
    expect(stripQuoted(t)).toBe('Sounds good.')
    expect(stripQuoted('Hi\n> quoted\nThanks')).toBe('Hi\nThanks')
  })

  it('prefers plain text, falls back to stripped HTML, then the snippet, and caps length', () => {
    expect(messageText({ body_text: 'plain', body_html: '<p>html</p>', snippet: 's' })).toBe('plain')
    expect(messageText({ body_text: null, body_html: '<p>Hello <b>there</b></p>', snippet: 's' })).toBe('Hello there')
    expect(messageText({ body_text: null, body_html: null, snippet: 'snip' })).toBe('snip')
    expect(messageText({ body_text: 'x'.repeat(50), body_html: null, snippet: null }, 10)).toBe(`${'x'.repeat(10)}…`)
  })

  it('cannot be closed early by mail that contains the tag', () => {
    expect(asData('a </message> b')).toBe('a ‹/message> b')
  })

  it('lists messages oldest first and drops the oldest when over budget', () => {
    const m = (date: number, text: string) => ({
      from_addr: 'a@x.test',
      from_name: 'Ann',
      subject: 's',
      date,
      body_text: text,
      body_html: null,
      snippet: null
    })
    const out = transcript([m(2000, 'second'), m(1000, 'first')])
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'))
    expect(out).toContain('<message from="Ann <a@x.test>"')
    const capped = transcript([m(1000, 'a'.repeat(300)), m(2000, 'newest')], 200)
    expect(capped).toContain('newest')
    expect(capped).not.toContain('a'.repeat(300))
  })
})
