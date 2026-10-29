import { existsSync } from 'fs'
import { getSettings, listAccounts, setSetting, upsertAccount } from '../store/repo.js'
import type { Account } from '../store/types.js'
import { loadAccountConfig, type AccountConfig } from './config.js'
import type { MailProvider, OAuthProvider } from './auth.js'
import { presetFor, providerPreset } from './presets.js'
import { authRefFor, deletePassword, getPassword, setPassword } from './vault.js'

/** The From: display name is per-account state, not a connection setting. */
export function displayNameKey(accountId: number): string {
  return `account.${accountId}.name`
}

export function displayNameFor(accountId: number): string | null {
  return getSettings()[displayNameKey(accountId)] ?? null
}

/** No-op for a blank name, so a re-migration cannot wipe one the user set. */
export function rememberDisplayName(accountId: number, name: string | null): void {
  const trimmed = name?.trim()
  if (!trimmed) return
  setSetting(displayNameKey(accountId), trimmed)
}

export interface NewAccountInput {
  email: string
  pass: string
  name: string | null
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  smtpSavesSent?: boolean
}

export function toConfig(input: NewAccountInput): AccountConfig {
  return {
    email: input.email.trim(),
    auth: { kind: 'password', pass: input.pass },
    provider: 'imap',
    name: input.name?.trim() || null,
    imapHost: input.imapHost.trim(),
    imapPort: input.imapPort,
    smtpHost: input.smtpHost.trim(),
    smtpPort: input.smtpPort,
    smtpSavesSent: input.smtpSavesSent ?? presetFor(input.email).smtpSavesSent
  }
}

/**
 * Persists connection metadata to SQLite and the password to the OS keychain.
 * upsert-by-email means re-adding an existing address updates it in place
 * rather than creating a duplicate mailbox.
 */
export function saveAccount(input: NewAccountInput): { account: Account; config: AccountConfig } {
  const config = toConfig(input)
  // Insert first: auth_ref is derived from the row id, which only exists after.
  const row = upsertAccount({
    email: config.email,
    imap_host: config.imapHost,
    imap_port: config.imapPort,
    smtp_host: config.smtpHost,
    smtp_port: config.smtpPort,
    auth_ref: null,
    provider: 'imap',
    auth_type: 'password'
  })
  const ref = authRefFor(row.id)
  if (config.auth.kind !== 'password') throw new Error('saveAccount is for password accounts')
  setPassword(ref, config.auth.pass)
  const account = upsertAccount({
    email: config.email,
    imap_host: config.imapHost,
    imap_port: config.imapPort,
    smtp_host: config.smtpHost,
    smtp_port: config.smtpPort,
    auth_ref: ref,
    provider: 'imap',
    auth_type: 'password'
  })
  // Display name is not a connection setting, so it lives in settings.
  return { account, config }
}

export interface NewOAuthAccountInput {
  email: string
  name: string | null
  provider: Exclude<MailProvider, 'imap'>
  oauthProvider: OAuthProvider
  refreshToken: string
}

/**
 * Same shape as saveAccount, but the vault holds the refresh token as JSON
 * instead of a password. Re-signing in to an existing address updates it in
 * place (upsert by email), which is also how re-auth works.
 */
export function saveOAuthAccount(input: NewOAuthAccountInput): { account: Account; config: AccountConfig } {
  const p = providerPreset(input.provider)
  const meta = {
    email: input.email.trim(),
    imap_host: p.imapHost,
    imap_port: p.imapPort,
    smtp_host: p.smtpHost,
    smtp_port: p.smtpPort,
    provider: input.provider,
    auth_type: 'oauth2' as const
  }
  const row = upsertAccount({ ...meta, auth_ref: null })
  const ref = authRefFor(row.id)
  setPassword(ref, JSON.stringify({ refreshToken: input.refreshToken }))
  const account = upsertAccount({ ...meta, auth_ref: ref })
  return { account, config: configForAccount(account, input.name)! }
}

export function forgetAccount(account: Account): void {
  if (account.auth_ref) deletePassword(account.auth_ref)
}

/** Null when the vault has no secret for the row — the user must re-auth. */
export function configForAccount(account: Account, name: string | null): AccountConfig | null {
  const ref = account.auth_ref ?? authRefFor(account.id)
  const secret = getPassword(ref)
  if (!secret) return null
  const smtpHost = account.smtp_host ?? presetFor(account.email).smtpHost
  const hosts = {
    imapHost: account.imap_host ?? presetFor(account.email).imapHost,
    imapPort: account.imap_port ?? 993,
    smtpHost,
    smtpPort: account.smtp_port ?? 465
  }
  if (account.auth_type === 'oauth2') {
    const provider = account.provider === 'microsoft' ? 'microsoft' : 'gmail'
    return {
      email: account.email,
      name,
      ...hosts,
      provider,
      auth: { kind: 'oauth2', provider: provider === 'gmail' ? 'google' : 'microsoft', ref },
      // Gmail and Exchange both file SMTP submissions into Sent themselves.
      smtpSavesSent: true
    }
  }
  return {
    email: account.email,
    name,
    ...hosts,
    provider: 'imap',
    auth: { kind: 'password', pass: secret },
    smtpSavesSent: /\.qq\.com$/i.test(smtpHost) || presetFor(account.email).smtpSavesSent
  }
}

/**
 * One-time lift of a legacy .env.local credential into the keychain. The file
 * is left untouched: deleting a user's config on upgrade would be a nasty
 * surprise, and a stale copy is harmless once the vault has the secret.
 */
export function migrateEnvAccount(envPath: string): { account: Account; config: AccountConfig } | null {
  if (!existsSync(envPath)) return null
  let config: AccountConfig
  try {
    config = loadAccountConfig(envPath)
  } catch {
    return null
  }
  const existing = listAccounts().find(
    (a) => a.email.toLowerCase() === config.email.toLowerCase()
  )
  // Already migrated: keep the keychain copy, which the user may have updated.
  if (existing?.auth_ref && getPassword(existing.auth_ref)) {
    // The name lives in settings, not on the account row, so a migration that
    // predates this would have left it unset — mail then goes out with a bare
    // address and clients render the local-part as the sender's name.
    rememberDisplayName(existing.id, config.name)
    const live = configForAccount(existing, displayNameFor(existing.id) ?? config.name)
    return live ? { account: existing, config: live } : null
  }
  // .env.local only ever holds a password account.
  if (config.auth.kind !== 'password') return null
  const saved = saveAccount({ ...config, pass: config.auth.pass, smtpSavesSent: config.smtpSavesSent })
  rememberDisplayName(saved.account.id, config.name)
  return saved
}

/** Every stored account that still has a usable password. */
export function loadStoredAccounts(
  displayName: (accountId: number) => string | null
): Array<{ account: Account; config: AccountConfig }> {
  const out: Array<{ account: Account; config: AccountConfig }> = []
  for (const account of listAccounts()) {
    const config = configForAccount(account, displayName(account.id))
    if (config) out.push({ account, config })
    else console.error(`[accounts] no keychain secret for ${account.email}; re-auth needed`)
  }
  return out
}
