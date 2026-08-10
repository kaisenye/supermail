import { describe, expect, it } from 'vitest'
import { encodeAddressList, encodeHeaderWord, htmlToPlainText } from './mime.js'

describe('encodeHeaderWord', () => {
  it('strips CRLF so a subject cannot inject a header', () => {
    // isAscii() returns true for \r and \n, so this once produced a real Bcc.
    // The text may survive as a value; what must not survive is the newline
    // that would end the Subject header and start a new one.
    const out = encodeHeaderWord('Hi\r\nBcc: evil@x.com')
    expect(out).not.toMatch(/[\r\n]/)
    expect(out).toBe('Hi Bcc: evil@x.com')
  })

  it('leaves plain ascii alone', () => {
    expect(encodeHeaderWord('Quarterly budget')).toBe('Quarterly budget')
  })

  it('encodes non-ascii as an encoded-word', () => {
    const out = encodeHeaderWord('预算')
    expect(out).toMatch(/^=\?UTF-8\?B\?/)
    expect(out).toMatch(/\?=$/)
  })
})

describe('encodeAddressList', () => {
  it('strips CRLF from addresses too', () => {
    const out = encodeAddressList('a@b.com\r\nBcc: evil@x.com')
    expect(out).not.toMatch(/[\r\n]/)
  })

  it('keeps a plain address unchanged', () => {
    expect(encodeAddressList('a@b.com')).toContain('a@b.com')
  })
})

describe('htmlToPlainText', () => {
  it('keeps one break per block, not two', () => {
    // Open and close tags both used to emit a break, doubling every line.
    const out = htmlToPlainText('<div>one</div><div>two</div>')
    expect(out).toBe('one\ntwo')
  })

  it('turns <br> into a single newline', () => {
    expect(htmlToPlainText('a<br>b')).toBe('a\nb')
  })

  it('does not run separate paragraphs together', () => {
    // "Hi Kaisen,<p>How're you" arriving as one line was the reported bug.
    expect(htmlToPlainText('<p>Hi</p><p>there</p>')).toBe('Hi\nthere')
  })

  it('decodes entities', () => {
    expect(htmlToPlainText('a&nbsp;b')).toContain('a b')
    expect(htmlToPlainText('&amp;')).toBe('&')
  })

  it('drops script and style content', () => {
    expect(htmlToPlainText('<style>p{color:red}</style>hi')).toBe('hi')
  })
})
