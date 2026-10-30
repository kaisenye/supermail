import { describe, expect, it } from 'vitest'
import { restoreSearch, scopeStep, searchStatus, type SearchCache } from './searchKeys'
import { stepIndex } from './threadNav'
import { buildChords, type Handlers } from './commands'

const k = (key: string, mods: Partial<Record<'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey', boolean>> = {}) => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods
})

describe('scopeStep', () => {
  it('moves the scope on Tab and Shift+Tab', () => {
    expect(scopeStep(k('Tab'))).toBe(1)
    expect(scopeStep(k('Tab', { shiftKey: true }))).toBe(-1)
    expect(scopeStep(k('a'))).toBe(0)
  })

  it('leaves modifier chords to the registry so Ctrl+Tab switches the workspace tab', () => {
    expect(scopeStep(k('Tab', { ctrlKey: true }))).toBe(0)
    expect(scopeStep(k('Tab', { ctrlKey: true, shiftKey: true }))).toBe(0)
    expect(scopeStep(k('Tab', { metaKey: true }))).toBe(0)
    expect(scopeStep(k('Tab', { altKey: true }))).toBe(0)
  })

  it('binds the tab chords on the search page', () => {
    const h = { 'tab.next': () => {}, 'tab.prev': () => {} } as Handlers
    expect(buildChords('search', h).map((c) => [c.key, !!c.shift, !!c.ctrl])).toEqual([
      ['Tab', false, true],
      ['Tab', true, true]
    ])
  })
})

describe('search page state', () => {
  const cache: SearchCache<number, string, string> = {
    query: 'invoice',
    scope: 'contacts',
    active: 7,
    emails: [1, 2, 3],
    contacts: ['a'],
    tasks: []
  }

  it('comes back from a thread on the same results, scope and row', () => {
    expect(restoreSearch(cache, 'invoice')).toBe(cache)
    expect(restoreSearch(cache, '  invoice ')).toBe(cache)
  })

  it('searches again for a different query', () => {
    expect(restoreSearch(cache, 'receipt')).toBeNull()
    expect(restoreSearch(null, 'invoice')).toBeNull()
  })

  it('tells searching, no results and a failure apart', () => {
    expect(searchStatus({ query: '', loading: false, error: null, count: 0 })).toBeNull()
    expect(searchStatus({ query: 'q', loading: true, error: null, count: 0 })).toBe('Searching…')
    expect(searchStatus({ query: ' q ', loading: false, error: null, count: 0 })).toBe('No results for “q”')
    expect(searchStatus({ query: 'q', loading: false, error: null, count: 3 })).toBeNull()
    expect(searchStatus({ query: 'q', loading: false, error: 'db locked', count: 0 })).toBe('Search failed: db locked')
  })

  it('↓ on an empty scope stays at row 0, never -1', () => {
    expect(stepIndex(0, 1, 0)).toBe(0)
    expect(stepIndex(2, 1, 3)).toBe(2)
    expect(stepIndex(0, -1, 3)).toBe(0)
  })
})
