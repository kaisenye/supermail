import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, initDb } from './db.js'
import { deleteSnippet, listSnippets, saveSnippet } from './snippets.js'

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'snippets-')), 't.db'))
})

describe('snippets', () => {
  it('saves, lists by name, updates and deletes', () => {
    const b = saveSnippet({ name: 'Thanks', shortcut: ';thx', body: 'Thanks {first_name}!\n' })
    saveSnippet({ name: 'Availability', shortcut: null, body: 'Free Tue' })
    expect(b).toMatchObject({ name: 'Thanks', shortcut: 'thx', body: 'Thanks {first_name}!' })
    expect(listSnippets().map((s) => s.name)).toEqual(['Availability', 'Thanks'])
    expect(saveSnippet({ id: b.id, name: 'Thanks!', shortcut: 'ty', body: 'Thank you' })).toMatchObject({
      id: b.id,
      shortcut: 'ty'
    })
    deleteSnippet(b.id)
    expect(listSnippets().map((s) => s.name)).toEqual(['Availability'])
  })

  it('refuses a missing name or body and a malformed shortcut', () => {
    expect(() => saveSnippet({ name: ' ', body: 'x' })).toThrow(/name/)
    expect(() => saveSnippet({ name: 'x', body: '  ' })).toThrow(/name/)
    expect(() => saveSnippet({ name: 'x', shortcut: 'two words', body: 'x' })).toThrow(/Shortcut/)
  })

  it('says which shortcut is taken, ignoring case', () => {
    saveSnippet({ name: 'A', shortcut: 'hi', body: 'a' })
    expect(() => saveSnippet({ name: 'B', shortcut: 'HI', body: 'b' })).toThrow(/;HI is already used/)
  })
})
