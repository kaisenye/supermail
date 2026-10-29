import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The vault needs Electron's safeStorage; an in-memory map stands in for it.
const secrets = new Map<string, string>()
vi.mock('./vault.js', () => ({
  authRefFor: (id: number) => `acct-${id}`,
  setPassword: (ref: string, v: string) => void secrets.set(ref, v),
  getPassword: (ref: string) => secrets.get(ref) ?? null,
  deletePassword: (ref: string) => void secrets.delete(ref)
}))

import { closeDb, initDb } from '../store/db.js'
import { configForAccount, saveAccount, saveOAuthAccount } from './manage.js'
import { listAccounts } from '../store/repo.js'

beforeEach(() => {
  secrets.clear()
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'manage-')), 't.db'))
})

describe('accounts', () => {
  it('round-trips a password account', () => {
    saveAccount({
      email: 'a@exmail.test',
      pass: 'pw',
      name: null,
      imapHost: 'imap.exmail.qq.com',
      imapPort: 993,
      smtpHost: 'smtp.exmail.qq.com',
      smtpPort: 465
    })
    const row = listAccounts()[0]
    expect(row.provider).toBe('imap')
    expect(row.auth_type).toBe('password')
    expect(configForAccount(row, null)?.auth).toEqual({ kind: 'password', pass: 'pw' })
  })

  it('round-trips a Google account without storing a password', () => {
    saveOAuthAccount({
      email: 'me@gmail.com',
      name: 'Me',
      provider: 'gmail',
      oauthProvider: 'google',
      refreshToken: 'r-1'
    })
    const row = listAccounts()[0]
    expect(row).toMatchObject({ provider: 'gmail', auth_type: 'oauth2', imap_host: 'imap.gmail.com' })
    expect(JSON.parse(secrets.get(row.auth_ref!)!)).toEqual({ refreshToken: 'r-1' })
    const cfg = configForAccount(row, 'Me')!
    expect(cfg.auth).toEqual({ kind: 'oauth2', provider: 'google', ref: row.auth_ref })
    expect(cfg.provider).toBe('gmail')
    expect(cfg.smtpSavesSent).toBe(true)
  })

  it('returns null for an OAuth account whose token is gone', () => {
    saveOAuthAccount({
      email: 'me@outlook.com',
      name: null,
      provider: 'microsoft',
      oauthProvider: 'microsoft',
      refreshToken: 'r'
    })
    secrets.clear()
    expect(configForAccount(listAccounts()[0], null)).toBeNull()
  })
})
