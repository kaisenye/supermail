import { describe, expect, it } from 'vitest'
import { nextSplitId, resolveSplitId } from './splitNav.js'

const list = [{ id: 'all' }, { id: 'important' }, { id: 'other' }, { id: 'custom:2' }]

describe('resolveSplitId', () => {
  it('keeps a split that still exists', () => {
    expect(resolveSplitId(list, 'custom:2')).toBe('custom:2')
  })
  it('falls back to All when the active split was deleted', () => {
    expect(resolveSplitId(list, 'custom:9')).toBe('all')
  })
})

describe('nextSplitId', () => {
  it('cycles forward and back, wrapping at both ends', () => {
    expect(nextSplitId(list, 'all', 1)).toBe('important')
    expect(nextSplitId(list, 'custom:2', 1)).toBe('all')
    expect(nextSplitId(list, 'all', -1)).toBe('custom:2')
  })
  it('treats a missing current split as the first, so Shift+Tab still reaches the last', () => {
    expect(nextSplitId(list, 'custom:9', -1)).toBe('custom:2')
    expect(nextSplitId(list, 'custom:9', 1)).toBe('important')
  })
  it('returns null for an empty list', () => {
    expect(nextSplitId([], 'all', 1)).toBeNull()
  })
})
