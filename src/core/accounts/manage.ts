import { existsSync } from 'fs'
import { getSettings, listAccounts, setSetting, upsertAccount } from '../store/repo.js'
import type { Account } from '../store/types.js'
import { loadAccountConfig, type AccountConfig } from './config.js'
import { presetFor } from './presets.js'
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
    // The name lives in settings, not on the account row, so a migration that
    // predates this would have left it unset — mail then goes out with a bare
    // address and clients render the local-part as the sender's name.
    rememberDisplayName(existing.id, config.name)
    const live = configForAccount(existing, displayNameFor(existing.id) ?? config.name)
    return live ? { account: existing, config: live } : null
  }
  const saved = saveAccount({ ...config, smtpSavesSent: config.smtpSavesSent })
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
