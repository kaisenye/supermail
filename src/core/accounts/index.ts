import { upsertAccount } from '../store/repo.js'
import type { Account } from '../store/types.js'
import { loadAccountConfig, type AccountConfig } from './config.js'

export { ConfigError, loadAccountConfig } from './config.js'
export type { AccountConfig } from './config.js'

/**
 * Upserts the configured account. Only connection metadata is persisted —
 * the password stays in memory and is passed to imap/smtp directly.
 */
export function bootstrapAccount(envPath: string): {
  account: Account
  config: AccountConfig
} {
  const config = loadAccountConfig(envPath)
  const account = upsertAccount({
    email: config.email,
    imap_host: config.imapHost,
    imap_port: config.imapPort,
    smtp_host: config.smtpHost,
    smtp_port: config.smtpPort,
    auth_ref: null
  })
  return { account, config }
}
