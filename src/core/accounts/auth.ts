import type { AccountConfig } from './config.js'

/** Which backend an account speaks to. All three are IMAP + SMTP today. */
export type MailProvider = 'imap' | 'gmail' | 'microsoft'

export type OAuthProvider = 'google' | 'microsoft'

/**
 * How an account authenticates. The secret never lives here: a password is
 * held in memory only after the vault hands it over, and OAuth keeps just the
 * vault ref of its refresh token.
 */
export type AccountAuth =
  | { kind: 'password'; pass: string }
  | { kind: 'oauth2'; provider: OAuthProvider; ref: string }

/** Vault ref -> fresh access token. Injected in tests. */
export type TokenSource = (ref: string, provider: OAuthProvider) => Promise<string>

async function defaultTokenSource(ref: string, provider: OAuthProvider): Promise<string> {
  const { getAccessToken } = await import('./oauth.js')
  return getAccessToken(ref, provider)
}

/** imapflow's `auth` option. */
export async function resolveAuth(
  config: AccountConfig,
  tokens: TokenSource = defaultTokenSource
): Promise<{ user: string; pass: string } | { user: string; accessToken: string }> {
  if (config.auth.kind === 'password') return { user: config.email, pass: config.auth.pass }
  return {
    user: config.email,
    accessToken: await tokens(config.auth.ref, config.auth.provider)
  }
}

/** nodemailer's `auth` option. */
export async function smtpAuth(
  config: AccountConfig,
  tokens: TokenSource = defaultTokenSource
): Promise<
  { user: string; pass: string } | { type: 'OAuth2'; user: string; accessToken: string }
> {
  const a = await resolveAuth(config, tokens)
  return 'pass' in a ? a : { type: 'OAuth2', user: a.user, accessToken: a.accessToken }
}
