import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import {
  addMessageLabel,
  gmailLabelChoices,
  labelsForMessages,
  messageLabels,
  removeMessageLabel,
  setMessageLabels,
  userLabels
} from './labels.js'

let msg: number

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'labels-')), 't.db'))
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@gmail.com')").run()
  db.prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox')").run()
  msg = Number(
    db.prepare("INSERT INTO messages (account_id,folder_id,uid,message_id) VALUES (1,1,1,'<a@x>')").run()
      .lastInsertRowid
  )
})

describe('Gmail label mapping', () => {
  it('drops system labels, which are folders or flags here', () => {
    expect(userLabels(['\\Inbox', '\\Important', 'Work', 'Clients/Acme', 'Work'])).toEqual([
      'Work',
      'Clients/Acme'
    ])
  })

  it('offers user-label folders, not system ones', () => {
    expect(
      gmailLabelChoices([
        { path: 'INBOX', role: 'inbox' },
        { path: '[Gmail]/All Mail', role: 'all' },
        { path: '[Gmail]/Starred', role: null },
        { path: 'Work', role: null },
        { path: 'Clients/Acme', role: null }
      ])
    ).toEqual(['Clients/Acme', 'Work'])
  })

  it('replaces a message’s labels and reports whether anything changed', () => {
    expect(setMessageLabels(msg, 1, ['Work', '\\Inbox'])).toBe(true)
    expect(setMessageLabels(msg, 1, ['Work'])).toBe(false)
    expect(messageLabels(msg)).toEqual(['Work'])
    expect(setMessageLabels(msg, 1, [])).toBe(true)
    expect(messageLabels(msg)).toEqual([])
  })

  it('adds and removes one label', () => {
    expect(addMessageLabel(msg, 1, 'Work')).toBe(true)
    expect(addMessageLabel(msg, 1, 'Work')).toBe(false)
    expect(labelsForMessages([msg])).toEqual({ [msg]: ['Work'] })
    expect(removeMessageLabel(msg, 1, 'Work')).toBe(true)
    expect(labelsForMessages([msg])).toEqual({ [msg]: [] })
  })
})
