import { describe, expect, it } from 'vitest'
import type { AccountConfig } from './config.js'
import { explain } from './verify.js'

const ms: AccountConfig = {
  email: 'me@corp.com',
  name: null,
  imapHost: 'outlook.office365.com',
  imapPort: 993,
  smtpHost: 'smtp.office365.com',
  smtpPort: 587,
  smtpSavesSent: true,
  provider: 'microsoft',
  auth: { kind: 'oauth2', provider: 'microsoft', ref: 'acct-1' }
}

describe('explain', () => {
  it('tells a Microsoft user their organisation may have IMAP turned off', () => {
    const msg = explain({ authenticationFailed: true, responseText: 'AUTHENTICATE failed.' }, 'imap', ms)
    expect(msg).toMatch(/organisation/i)
    expect(msg).not.toMatch(/password/i)
  })

  it('names SMTP AUTH when SMTP is the leg that fails for Microsoft', () => {
    const msg = explain({ responseText: '535 5.7.139 SmtpClientAuthentication is disabled' }, 'smtp', ms)
    expect(msg).toMatch(/SMTP AUTH/)
  })

  it('does not blame SMTP AUTH for a generic Microsoft 535', () => {
    const msg = explain({ responseText: '535 5.7.3 Authentication unsuccessful' }, 'smtp', ms)
    expect(msg).not.toMatch(/SMTP AUTH/)
  })

  it('tells a Google user to sign in again rather than fix a password', () => {
    const g: AccountConfig = { ...ms, provider: 'gmail', auth: { kind: 'oauth2', provider: 'google', ref: 'a' } }
    expect(explain({ authenticationFailed: true }, 'imap', g)).toMatch(/sign in again/i)
  })

  it('says plainly when a server offers no encryption on that port', () => {
    const pw: AccountConfig = {
      ...ms,
      imapHost: 'mail.example.com',
      imapPort: 143,
      smtpPort: 25,
      provider: 'imap',
      auth: { kind: 'password', pass: 'x' }
    }
    const imap = explain({ message: 'Server does not support STARTTLS' }, 'imap', pw)
    expect(imap).toMatch(/no encrypted connection on port 143/i)
    expect(imap).toMatch(/993/)
    const smtp = explain(
      { message: 'Error upgrading connection with STARTTLS: 500 Invalid command', code: 'ETLS' },
      'smtp',
      pw
    )
    expect(smtp).toMatch(/no encrypted connection on port 25/i)
    expect(smtp).toMatch(/465/)
  })

  it('keeps the password hint for password accounts', () => {
    const pw: AccountConfig = { ...ms, provider: 'imap', auth: { kind: 'password', pass: 'x' } }
    expect(explain({ authenticationFailed: true }, 'imap', pw)).toMatch(/password/i)
  })
})
