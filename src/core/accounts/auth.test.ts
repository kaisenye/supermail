import { describe, expect, it } from 'vitest'
import type { AccountConfig } from './config.js'
import { resolveAuth, smtpAuth } from './auth.js'

const base = {
  email: 'me@example.com',
  name: null,
  imapHost: 'imap.example.com',
  imapPort: 993,
  smtpHost: 'smtp.example.com',
  smtpPort: 465,
  smtpSavesSent: false
}

const pw: AccountConfig = { ...base, provider: 'imap', auth: { kind: 'password', pass: 'secret' } }
const oauth: AccountConfig = {
  ...base,
  provider: 'gmail',
  auth: { kind: 'oauth2', provider: 'google', ref: 'acct-1' }
}

describe('resolveAuth', () => {
  it('passes a password through', async () => {
    expect(await resolveAuth(pw)).toEqual({ user: 'me@example.com', pass: 'secret' })
  })

  it('asks the token source for an OAuth access token', async () => {
    const calls: string[] = []
    const auth = await resolveAuth(oauth, async (ref) => {
      calls.push(ref)
      return 'tok-1'
    })
    expect(auth).toEqual({ user: 'me@example.com', accessToken: 'tok-1' })
    expect(calls).toEqual(['acct-1'])
  })
})

describe('smtpAuth', () => {
  it('maps a password to nodemailer login auth', async () => {
    expect(await smtpAuth(pw)).toEqual({ user: 'me@example.com', pass: 'secret' })
  })

  it('maps OAuth to nodemailer XOAUTH2', async () => {
    expect(await smtpAuth(oauth, async () => 'tok-2')).toEqual({
      type: 'OAuth2',
      user: 'me@example.com',
      accessToken: 'tok-2'
    })
  })
})
