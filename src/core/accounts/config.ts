import { readFileSync, existsSync } from 'fs'
import type { AccountAuth, MailProvider } from './auth.js'

export interface AccountConfig {
  email: string
  auth: AccountAuth
  /** Drives provider-specific sync rules (Gmail's duplicate label folders). */
  provider: MailProvider
  /** Display name for From: header. Falls back to bare email if unset. */
  name: string | null
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  /**
   * True when the SMTP server files outgoing mail into Sent itself, so an
   * explicit IMAP APPEND would leave a second copy. Exmail does this — it
   * even answers the APPEND with "Mail has saved by smtp!".
   */
  smtpSavesSent: boolean
}

/** RFC 5322 From value: `"Name" <addr>` or bare addr. */
export function formatFromHeader(config: AccountConfig): string {
  const name = config.name?.trim()
  if (!name) return config.email
  const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}" <${config.email}>`
}

const DEFAULTS = {
  imapHost: 'imap.exmail.qq.com',
  imapPort: 993,
  smtpHost: 'smtp.exmail.qq.com',
  smtpPort: 465
}

export class ConfigError extends Error {}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    let val = t.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (key) out[key] = val
  }
  return out
}

/** Prefer SOVO_*; accept the older SUPERMAIL_* and ROMO_* names for existing installs. */
function envGet(env: Record<string, string>, key: string): string | undefined {
  return env[key] || env[key.replace(/^SOVO_/, 'SUPERMAIL_')] || env[key.replace(/^SOVO_/, 'ROMO_')]
}

/**
 * Stage-1 credential source. Password stays in memory — never SQLite.
 * Planned: accounts.auth_ref + keytar.
 */
export function loadAccountConfig(envPath: string): AccountConfig {
  if (!existsSync(envPath)) {
    throw new ConfigError(
      `Missing ${envPath}. Create it with:\n` +
        `  SOVO_EMAIL=you@yourdomain.com\n` +
        `  SOVO_PASS=<app-specific password from the Exmail admin console>\n` +
        `  SOVO_NAME=Your Full Name\n` +
        `Note: Exmail rejects your normal login password here.`
    )
  }

  const env = parseEnv(readFileSync(envPath, 'utf8'))
  const email = envGet(env, 'SOVO_EMAIL')
  const pass = envGet(env, 'SOVO_PASS')

  if (!email) throw new ConfigError(`SOVO_EMAIL not set in ${envPath}`)
  if (!pass) throw new ConfigError(`SOVO_PASS not set in ${envPath}`)

  const port = (key: string, fallback: number): number => {
    const raw = envGet(env, key)
    if (!raw) return fallback
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      throw new ConfigError(`${key} must be a valid port, got "${raw}"`)
    }
    return n
  }

  return {
    email,
    auth: { kind: 'password', pass },
    provider: 'imap',
    name: envGet(env, 'SOVO_NAME')?.trim() || null,
    imapHost: envGet(env, 'SOVO_IMAP_HOST') || DEFAULTS.imapHost,
    imapPort: port('SOVO_IMAP_PORT', DEFAULTS.imapPort),
    smtpHost: envGet(env, 'SOVO_SMTP_HOST') || DEFAULTS.smtpHost,
    smtpPort: port('SOVO_SMTP_PORT', DEFAULTS.smtpPort),
    // Exmail/QQ file sent mail during SMTP. Default on for those hosts, and
    // overridable for anything else.
    smtpSavesSent: (() => {
      const raw = envGet(env, 'SOVO_SMTP_SAVES_SENT')?.trim().toLowerCase()
      if (raw === 'true' || raw === '1') return true
      if (raw === 'false' || raw === '0') return false
      const host = (envGet(env, 'SOVO_SMTP_HOST') || DEFAULTS.smtpHost).toLowerCase()
      return /\.qq\.com$/.test(host)
    })()
  }
}
