import { describe, expect, it } from 'vitest'
import { budgetEdit, modelEdit } from './aiSettingsInput'

describe('budgetEdit', () => {
  it('does not save a cleared field as a $0 budget', () => {
    expect(budgetEdit('', 1)).toBeNull()
    expect(budgetEdit('   ', 1)).toBeNull()
  })

  it('does not save an unchanged budget', () => {
    expect(budgetEdit('1', 1)).toBeNull()
    expect(budgetEdit('1.0', 1)).toBeNull()
  })

  it('does not save text that is not a number', () => {
    expect(budgetEdit('abc', 1)).toBeNull()
  })

  it('saves a real edit, including a deliberate 0', () => {
    expect(budgetEdit('2.5', 1)).toBe(2.5)
    expect(budgetEdit('0', 1)).toBe(0)
  })
})

describe('modelEdit', () => {
  it('does not save an unchanged model', () => {
    expect(modelEdit('', '')).toBeNull()
    expect(modelEdit('gpt-x', 'gpt-x')).toBeNull()
    expect(modelEdit(' gpt-x ', 'gpt-x')).toBeNull()
  })

  it('saves a new model, and a cleared field as a reset to the default', () => {
    expect(modelEdit('gpt-y', 'gpt-x')).toBe('gpt-y')
    expect(modelEdit('', 'gpt-x')).toBe('')
  })
})
