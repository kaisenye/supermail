import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { archiveSetup, GMAIL_ALL_MAIL_HIDDEN } from './archiveSetup.js'

describe('archiveSetup', () => {
  it('offers to create Archive on IMAP and Microsoft when none exists', () => {
    expect(archiveSetup('imap', false)).toEqual({ hasArchive: false, canCreate: true })
    expect(archiveSetup('microsoft', false)).toEqual({ hasArchive: false, canCreate: true })
  })

  it('never offers creation on Gmail: Done goes to All Mail, not an Archive label', () => {
    expect(archiveSetup('gmail', false)).toEqual({
      hasArchive: false,
      canCreate: false,
      reason: GMAIL_ALL_MAIL_HIDDEN
    })
  })

  it('offers nothing once the Done folder exists', () => {
    for (const p of ['imap', 'microsoft', 'gmail'] as const) {
      expect(archiveSetup(p, true)).toEqual({ hasArchive: true, canCreate: false })
    }
  })
})

describe('triage IPC uses archiveSetup', () => {
  const src = readFileSync(join(__dirname, '../../../electron/ipcTriage.ts'), 'utf8')
  const create = src.slice(src.indexOf("'triage:createArchive'"))

  it('createArchive refuses before mailboxCreate when creation is not allowed', () => {
    const guard = create.indexOf('!plan.canCreate')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(create.indexOf('mailboxCreate'))
  })

  it('assigns the provider Done role, not a hardcoded archive', () => {
    expect(create).toContain('doneRole(s.config.provider)')
    expect(create).not.toContain("created.path, 'archive'")
  })

  it('archiveStatus reports canCreate', () => {
    expect(src.slice(0, src.indexOf("'triage:createArchive'"))).toContain('archiveSetup(')
  })
})
