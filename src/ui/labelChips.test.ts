import { describe, expect, it } from 'vitest'
import { rowChips } from './labelChips'

const row = (o: { ai_important?: number | null; ai_category?: string | null; ai_labels?: string | null }) => ({
  ai_important: null,
  ai_category: null,
  ai_labels: null,
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

  it('keeps at most three', () => {
    expect(rowChips(row({ ai_important: 1, ai_category: 'work', ai_labels: 'A,B,C' })).map((c) => c.name)).toEqual([
      'Important',
      'Work',
      'A'
    ])
  })
})
