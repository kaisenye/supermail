import { describe, expect, it } from 'vitest'
import { DEFAULT_SIDEBAR_LABELS, labelInk, rowChips, yourSidebarLabels } from './labelChips'

const row = (o: {
  ai_important?: number | null
  ai_category?: string | null
  ai_labels?: string | null
  server_labels?: string | null
}) => ({
  ai_important: null,
  ai_category: null,
  ai_labels: null,
  server_labels: null,
  ...o
})

describe('rowChips', () => {
  it('shows nothing for an unsorted row', () => {
    expect(rowChips(row({}))).toEqual([])
  })

  it('puts Important first, then the category, then the inbox labels', () => {
    expect(rowChips(row({ ai_important: 1, ai_category: 'billing', ai_labels: 'House' }))).toEqual([
      { name: 'Important', tone: 'important' },
      { name: 'Billing', tone: 'billing' },
      { name: 'House', tone: 'label' }
    ])
  })

  it('leaves out Other, a not-important verdict and a label repeating the category', () => {
    expect(rowChips(row({ ai_important: 0, ai_category: 'other', ai_labels: 'Auto' }))).toEqual([
      { name: 'Auto', tone: 'label' }
    ])
    expect(rowChips(row({ ai_category: 'billing', ai_labels: 'billing,USCIS' })).map((c) => c.name)).toEqual([
      'Billing',
      'USCIS'
    ])
  })

  it('adds the Gmail labels after the inbox\'s own, once each', () => {
    expect(rowChips(row({ ai_category: 'billing', ai_labels: 'House', server_labels: 'Billing,USCIS,house' })).map((c) => c.name)).toEqual([
      'Billing',
      'House',
      'USCIS'
    ])
  })

  it('keeps every label: the row stacks three or more', () => {
    expect(rowChips(row({ ai_important: 1, ai_category: 'work', ai_labels: 'A,B,C' })).map((c) => c.name)).toEqual([
      'Important',
      'Work',
      'A',
      'B',
      'C'
    ])
  })
})

describe('sidebar labels', () => {
  it('always lists Important and every category but Other', () => {
    expect(DEFAULT_SIDEBAR_LABELS.map((l) => l.name)).toEqual([
      'Important',
      'Personal',
      'Work',
      'Billing',
      'Notification',
      'Marketing',
      'Newsletter',
      'Calendar',
      'Support'
    ])
  })

  it('puts the server labels before the inbox\'s own, skipping a name a default already has', () => {
    expect(yourSidebarLabels({ provider: ['Travel'], own: ['USCIS', 'work'] })).toEqual([
      { name: 'Travel', tone: 'label', chip: 'gmail:Travel' },
      { name: 'USCIS', tone: 'label', chip: 'label:USCIS' }
    ])
  })
})

describe('Gmail label colours', () => {
  it('take the colourful half of the pair, and none for a grey pair', () => {
    expect(labelInk({ bg: '#16a766', fg: '#ffffff' })).toBe('#16a766')
    expect(labelInk({ bg: '#b9e4d0', fg: '#0b804b' })).toBe('#0b804b')
    expect(labelInk({ bg: '#000000', fg: '#ffffff' })).toBeUndefined()
    expect(labelInk(undefined)).toBeUndefined()
  })

  it('colour the Gmail label chips and sidebar dots', () => {
    const colors = { USCIS: { bg: '#4a86e8', fg: '#ffffff' } }
    expect(rowChips(row({ server_labels: 'USCIS,House' }), colors)).toEqual([
      { name: 'USCIS', tone: 'label', color: '#4a86e8' },
      { name: 'House', tone: 'label' }
    ])
    expect(yourSidebarLabels({ provider: ['USCIS'], own: [], colors })[0].color).toBe('#4a86e8')
  })
})
