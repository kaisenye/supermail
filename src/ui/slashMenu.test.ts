import { describe, expect, it } from 'vitest'
import { filterSlashItems, slashQuery } from './slashMenu'

describe('slash menu', () => {
  it('opens on a slash at the start of a line or after a space', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('Notes /he')).toBe('he')
    expect(slashQuery('/heading 2')).toBe('heading 2')
  })

  it('stays shut inside a word, a URL or a date', () => {
    expect(slashQuery('and/or')).toBeNull()
    expect(slashQuery('https://x.com/a')).toBeNull()
    expect(slashQuery('10/31')).toBeNull()
    expect(slashQuery('plain text')).toBeNull()
  })

  it('closes once the query cannot be a command any more', () => {
    expect(slashQuery('/this is clearly a sentence now')).toBeNull()
  })

  it('lists every text type, and filters by name or shorthand', () => {
    expect(filterSlashItems('').map((i) => i.label)).toEqual([
      'Text',
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Bulleted list',
      'Numbered list',
      'Quote',
      'Code block',
      'Divider'
    ])
    expect(filterSlashItems('h2').map((i) => i.label)).toEqual(['Heading 2'])
    expect(filterSlashItems('head').map((i) => i.label)).toEqual(['Heading 1', 'Heading 2', 'Heading 3'])
    expect(filterSlashItems('bul').map((i) => i.label)).toEqual(['Bulleted list'])
    expect(filterSlashItems('zzz')).toEqual([])
  })
})
