import { existsSync } from 'fs'
import { listAccounts, upsertAccount } from '../store/repo.js'
import type { Account } from '../store/types.js'
import { loadAccountConfig, type AccountConfig } from './config.js'
import { presetFor } from './presets.js'
import { authRefFor, deletePassword, getPassword, setPassword } from './vault.js'

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
    pass: input.pass,
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
    auth_ref: null
  })
  const ref = authRefFor(row.id)
  setPassword(ref, config.pass)
  const account = upsertAccount({
    email: config.email,
    imap_host: config.imapHost,
    imap_port: config.imapPort,
    smtp_host: config.smtpHost,
    smtp_port: config.smtpPort,
    auth_ref: ref
  })
  // Display name is not a connection setting, so it lives in settings.
  return { account, config }
}

export function forgetAccount(account: Account): void {
  if (account.auth_ref) deletePassword(account.auth_ref)
}

/** Null when the keychain has no secret for the row — the user must re-auth. */
export function configForAccount(
  account: Account,
  name: string | null
): AccountConfig | null {
  const ref = account.auth_ref ?? authRefFor(account.id)
  const pass = getPassword(ref)
  if (!pass) return null
  const smtpHost = account.smtp_host ?? presetFor(account.email).smtpHost
  return {
    email: account.email,
    pass,
    name,
    imapHost: account.imap_host ?? presetFor(account.email).imapHost,
    imapPort: account.imap_port ?? 993,
    smtpHost,
    smtpPort: account.smtp_port ?? 465,
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
    const live = configForAccount(existing, config.name)
    return live ? { account: existing, config: live } : null
  }
  return saveAccount({ ...config, smtpSavesSent: config.smtpSavesSent })
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
