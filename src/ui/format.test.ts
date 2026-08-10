import { describe, expect, it } from 'vitest'
import { recipientLabel, senderLabel } from './format.js'

describe('recipientLabel', () => {
  it('falls back to the sender when the column was never selected', () => {
    // A renderer running against an older main process gets undefined here;
    // claiming "(no recipient)" would state something false about the message.
    expect(recipientLabel(undefined, 'Kaisen Ye')).toBe('Kaisen Ye')
  })

  it('says no recipient only when there genuinely is none', () => {
    expect(recipientLabel('[]', 'X')).toBe('(no recipient)')
    expect(recipientLabel(null, 'X')).toBe('(no recipient)')
  })

  it('uses the display name when present', () => {
    expect(recipientLabel('[{"address":"a@b.com","name":"Efrain"}]', 'X')).toBe('Efrain')
  })

  it('falls back to the local-part when there is no name', () => {
    expect(recipientLabel('[{"address":"burban@poltra.pl","name":null}]', 'X')).toBe('burban')
  })

  it('collapses extra recipients so the column stays one line', () => {
    expect(recipientLabel('[{"name":"Ann"},{"name":"Bob"},{"name":"Cy"}]', 'X')).toBe('Ann +2')
  })

  it('falls back rather than throwing on malformed json', () => {
    expect(recipientLabel('not json', 'Kaisen Ye')).toBe('Kaisen Ye')
  })
})

describe('senderLabel', () => {
  it('prefers the name', () => {
    expect(senderLabel('Ann Lee', 'a@b.com')).toBe('Ann Lee')
  })
  it('falls back to the local-part', () => {
    expect(senderLabel(null, 'a@b.com')).toBe('a')
  })
  it('handles a missing address', () => {
    expect(senderLabel(null, null)).toBe('(unknown)')
  })
})
