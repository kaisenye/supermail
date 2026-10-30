import { describe, expect, it } from 'vitest'
import { instantIntro, namedAddress, replyAllCc } from './intro.js'

describe('instantIntro', () => {
  it('moves the introducer to Bcc and writes to the person introduced', () => {
    expect(
      instantIntro({ to: 'Ann Lee <ann@x.test>', cc: 'bob@y.test, carl@z.test', bcc: '', body: '<p>Hi</p>' })
    ).toEqual({
      to: 'bob@y.test',
      cc: 'carl@z.test',
      bcc: 'Ann Lee <ann@x.test>',
      body: '<p>Thanks Ann! (Moving you to Bcc.)</p><p>Hi</p>'
    })
  })

  it('keeps other To recipients on the To line, and names someone from their address', () => {
    expect(instantIntro({ to: 'ann@x.test, bob@y.test', cc: 'carl@z.test', bcc: '', body: '' })).toEqual({
      to: 'bob@y.test',
      cc: 'carl@z.test',
      bcc: 'ann@x.test',
      body: '<p>Thanks Ann! (Moving you to Bcc.)</p>'
    })
  })

  it('does not put the introducer in Bcc twice', () => {
    expect(instantIntro({ to: 'ann@x.test', cc: 'bob@y.test', bcc: 'ANN@x.test', body: '' })?.bcc).toBe('ann@x.test')
  })

  it('escapes the name it writes', () => {
    expect(instantIntro({ to: 'R&D <rd@x.test>', cc: 'bob@y.test', bcc: '', body: '' })?.body).toBe(
      '<p>Thanks R&amp;D! (Moving you to Bcc.)</p>'
    )
  })

  it('gives up when nobody would be left to write to', () => {
    expect(instantIntro({ to: 'ann@x.test', cc: '', bcc: '', body: '' })).toBeNull()
    expect(instantIntro({ to: '', cc: 'bob@y.test', bcc: '', body: '' })).toBeNull()
  })

  it('greets by first name from a dotted or tagged address', () => {
    expect(instantIntro({ to: 'ann.lee@x.test', cc: 'bob@y.test', bcc: '', body: '' })?.body).toBe(
      '<p>Thanks Ann! (Moving you to Bcc.)</p>'
    )
    expect(instantIntro({ to: 'j_smith+intro@x.test', cc: 'bob@y.test', bcc: '', body: '' })?.body).toBe(
      '<p>Thanks J! (Moving you to Bcc.)</p>'
    )
  })

  it('greets a reply recipient built from the sender name', () => {
    const to = namedAddress('Ann Lee', 'ann.lee@x.test')
    expect(instantIntro({ to, cc: 'bob@y.test', bcc: '', body: '' })).toMatchObject({
      to: 'bob@y.test',
      bcc: 'Ann Lee <ann.lee@x.test>',
      body: '<p>Thanks Ann! (Moving you to Bcc.)</p>'
    })
  })
})

describe('namedAddress', () => {
  it('puts the name in front of the address', () => {
    expect(namedAddress('Ann Lee', 'ann@x.test')).toBe('Ann Lee <ann@x.test>')
  })

  it('falls back to the bare address without a name', () => {
    expect(namedAddress(null, 'ann@x.test')).toBe('ann@x.test')
    expect(namedAddress('  ', 'ann@x.test')).toBe('ann@x.test')
  })

  it('drops characters that would split or break the recipient list', () => {
    const to = namedAddress('Lee, Ann; "Sales" <team>', 'ann@x.test')
    expect(to).toBe('Lee Ann Sales team <ann@x.test>')
    expect(instantIntro({ to, cc: 'bob@y.test', bcc: '', body: '' })?.bcc).toBe(to)
  })
})

describe('replyAllCc', () => {
  it('reads the JSON array synced mail stores, leaving out me and the sender', () => {
    const to = JSON.stringify([
      { address: 'Me@Corp.test', name: 'Me' },
      { address: 'ann@x.test', name: 'Ann Lee' },
      { address: 'bob@y.test', name: null }
    ])
    const cc = JSON.stringify([
      { address: 'boss@corp.test', name: 'The Boss' },
      { address: 'ANN@x.test', name: 'Ann again' }
    ])
    expect(replyAllCc(to, cc, ['me@corp.test', 'boss@corp.test'])).toBe('Ann Lee <ann@x.test>, bob@y.test')
  })

  it('falls back to splitting plain strings (local drafts)', () => {
    expect(replyAllCc('Ann <ann@x.test>; me@corp.test', 'bob@y.test, ann@x.test', ['me@corp.test', null])).toBe(
      'Ann <ann@x.test>, bob@y.test'
    )
  })

  it('is empty when nobody else is on the mail', () => {
    expect(replyAllCc(JSON.stringify([{ address: 'me@corp.test' }]), null, ['me@corp.test'])).toBe('')
    expect(replyAllCc(null, '', [])).toBe('')
  })
})
