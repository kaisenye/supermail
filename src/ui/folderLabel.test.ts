import { describe, expect, it } from 'vitest'
import { folderLabel } from './format.js'

describe('folderLabel', () => {
  it('names special folders by role, whatever the server path', () => {
    expect(folderLabel({ path: 'Sent Messages', name: 'Sent Messages', role: 'sent' })).toBe('Sent')
    expect(folderLabel({ path: '[Gmail]/Sent Mail', name: 'Sent Mail', role: 'sent' })).toBe('Sent')
    expect(folderLabel({ path: 'Deleted Messages', name: null, role: 'trash' })).toBe('Trash')
    expect(folderLabel({ path: '[Gmail]/All Mail', name: 'All Mail', role: 'all' })).toBe('All Mail')
  })

  it('keeps the name of a custom folder', () => {
    expect(folderLabel({ path: '客户', name: '客户', role: null })).toBe('客户')
  })

  it('falls back to the leaf of the path', () => {
    expect(folderLabel({ path: 'Projects/2026', name: null, role: null })).toBe('2026')
  })
})
