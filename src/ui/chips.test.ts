import { describe, expect, it } from 'vitest'
import { CHIPS, chipLabel, gmailChip, labelChip, viewQuery } from './chips.js'

describe('viewQuery', () => {
  it('ANDs the split query and the chip query', () => {
    expect(viewQuery('is:important', 'unread')).toBe('is:important is:unread')
    expect(viewQuery('', 'needsReply')).toBe('is:needs-reply')
    expect(viewQuery('from:bob', null)).toBe('from:bob')
    expect(viewQuery('', null)).toBe('')
  })
  it('offers Unread, Needs reply, Waiting and Starred', () => {
    expect(CHIPS.map((c) => c.label)).toEqual(['Needs reply', 'Waiting', 'Unread', 'Starred'])
  })
  it('filters on a sidebar label, quoted so a name with spaces holds', () => {
    expect(viewQuery('', labelChip('billing'))).toBe('ai:"billing"')
    expect(viewQuery('is:important', labelChip('Home Depot'))).toBe('is:important ai:"Home Depot"')
    expect(chipLabel(labelChip('USCIS'))).toBe('USCIS')
    expect(chipLabel('unread')).toBeNull()
  })
  it('filters Important on the verdict and a Gmail label on the server label', () => {
    expect(viewQuery('', labelChip('Important'))).toBe('is:important')
    expect(viewQuery('', gmailChip('Clients/Acme'))).toBe('label:"Clients/Acme"')
    expect(chipLabel(gmailChip('Travel'))).toBe('Travel')
  })
})
