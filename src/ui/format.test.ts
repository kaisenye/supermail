import { describe, expect, it } from 'vitest'
import { formatFullDate, recipientLabel, recipientNames, senderLabel } from './format.js'

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

describe('thread header text', () => {
  it('writes the full date the way Scape does: month, ordinal day, time', () => {
    const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime()
    expect(formatFullDate(at(2026, 9, 13, 11, 54))).toMatch(/^Oct 13th, 11:54\sAM$/)
    expect(formatFullDate(at(2026, 9, 1, 15, 5))).toMatch(/^Oct 1st, 3:05\sPM$/)
    expect(formatFullDate(at(2026, 9, 22, 9, 0))).toMatch(/^Oct 22nd, 9:00\sAM$/)
    expect(formatFullDate(at(2026, 9, 11, 9, 0))).toMatch(/^Oct 11th/)
    expect(formatFullDate(null)).toBe('')
  })

  it('lists every recipient by name, falling back to the address', () => {
    const to = JSON.stringify([{ name: 'Kaisen Ye', address: 'k@x.com' }, { name: null, address: 'bob@y.com' }])
    expect(recipientNames(to, JSON.stringify([{ name: 'Ann', address: 'a@z.com' }]))).toBe('Kaisen Ye, bob@y.com, Ann')
    expect(recipientNames(null, null)).toBe('')
    expect(recipientNames('not json', null)).toBe('')
  })
})
