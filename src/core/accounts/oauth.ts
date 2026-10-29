import { createHash, randomBytes } from 'crypto'
import type { OAuthProvider } from './auth.js'
import { oauthClient } from './oauthClients.js'
import { getPassword, setPassword } from './vault.js'

const ENDPOINTS: Record<OAuthProvider, { auth: string; token: string; scope: string }> = {
  google: {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://mail.google.com/ openid email'
  },
  microsoft: {
    auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope:
      'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email'
  }
}

/** Refresh this long before expiry, so a token never dies mid-connect. */
const EARLY_MS = 5 * 60_000

export class OAuthNotConfigured extends Error {}
/** The refresh token was revoked or expired; only a new sign-in fixes it. */
export class ReauthRequired extends Error {
  constructor(public ref: string) {
    super('sign-in expired')
  }
}

function client(provider: OAuthProvider) {
  const c = oauthClient(provider)
  if (!c) {
    throw new OAuthNotConfigured(
      provider === 'google'
        ? 'Google sign-in is not configured: set MAIN_VITE_GOOGLE_CLIENT_ID and MAIN_VITE_GOOGLE_CLIENT_SECRET.'
        : 'Microsoft sign-in is not configured: set MAIN_VITE_MS_CLIENT_ID.'
    )
  }
  return c
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function randomState(): string {
  return randomBytes(16).toString('base64url')
}

export function authUrl(
  provider: OAuthProvider,
  redirectUri: string,
  challenge: string,
  state: string
): string {
  const e = ENDPOINTS[provider]
  const u = new URL(e.auth)
  u.searchParams.set('client_id', client(provider).clientId)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('scope', e.scope)
  u.searchParams.set('code_challenge', challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', state)
  if (provider === 'google') {
    // Without both, Google omits the refresh token on a repeat consent.
    u.searchParams.set('access_type', 'offline')
    u.searchParams.set('prompt', 'consent')
  } else {
    u.searchParams.set('prompt', 'select_account')
  }
  return u.toString()
}

/**
 * The id_token came straight from the token endpoint over TLS in response to
 * our own code exchange, so its signature adds nothing here; it is only read
 * for the address, never trusted for authorisation.
 */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null
  try {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString())
    const v = claims.email ?? claims.preferred_username
    return typeof v === 'string' && v.includes('@') ? v : null
  } catch {
    return null
  }
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
  error?: string
  error_description?: string
}

async function postToken(
  provider: OAuthProvider,
  params: Record<string, string>,
  fetchFn: typeof fetch
): Promise<{ status: number; body: TokenResponse }> {
  const c = client(provider)
  const body = new URLSearchParams({ client_id: c.clientId, ...params })
  if (c.clientSecret) body.set('client_secret', c.clientSecret)
  if (provider === 'microsoft') body.set('scope', ENDPOINTS.microsoft.scope)
  const res = await fetchFn(ENDPOINTS[provider].token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as TokenResponse }
}

export async function exchangeCode(
  provider: OAuthProvider,
  code: string,
  verifier: string,
  redirectUri: string,
  fetchFn: typeof fetch = fetch
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; email: string | null }> {
  const { status, body } = await postToken(
    provider,
    { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri },
    fetchFn
  )
  if (status >= 400 || !body.access_token) {
    throw new Error(body.error_description ?? body.error ?? `token exchange failed (${status})`)
  }
  if (!body.refresh_token) {
    throw new Error('The provider returned no refresh token, so Supermail could not stay signed in.')
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    email: emailFromIdToken(body.id_token)
  }
}

const cache = new Map<string, { token: string; expiresAt: number }>()
const inflight = new Map<string, Promise<string>>()
/** Refs whose refresh token was rejected; only a new sign-in revives them. */
const dead = new Set<string>()
const reauthListeners = new Set<(ref: string) => void>()

export function onReauthRequired(fn: (ref: string) => void): () => void {
  reauthListeners.add(fn)
  return () => reauthListeners.delete(fn)
}

/** Seeds the cache right after sign-in, so verify does not refresh at once. */
export function primeAccessToken(ref: string, token: string, expiresAt: number): void {
  cache.set(ref, { token, expiresAt })
}

/** Forget a token the server just rejected, so the next call refreshes. */
export function invalidateAccessToken(ref: string): void {
  cache.delete(ref)
}

/** A new sign-in stored a fresh refresh token: forget the dead mark and any cached token. */
export function reviveToken(ref: string): void {
  dead.delete(ref)
  cache.delete(ref)
}

export function resetTokenCache(): void {
  cache.clear()
  inflight.clear()
  dead.clear()
}

/** A valid access token for the account behind `ref`, refreshing when close to expiry. */
export async function getAccessToken(
  ref: string,
  provider: OAuthProvider,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  // Without this every IDLE reconnect and poll would re-POST a token the
  // provider already rejected, and re-fire the re-auth signal each time.
  if (dead.has(ref)) throw new ReauthRequired(ref)
  const hit = cache.get(ref)
  if (hit && hit.expiresAt - EARLY_MS > Date.now()) return hit.token
  const pending = inflight.get(ref)
  if (pending) return pending

  const run = (async () => {
    const stored = getPassword(ref)
    const refreshToken = stored ? (JSON.parse(stored) as { refreshToken?: string }).refreshToken : null
    if (!refreshToken) throw new ReauthRequired(ref)
    const { status, body } = await postToken(
      provider,
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      fetchFn
    )
    // Only invalid_grant means the refresh token itself is dead. A 400 for
    // invalid_client is a configuration bug, and a new sign-in would not fix it.
    if (body.error === 'invalid_grant') {
      if (!dead.has(ref)) {
        dead.add(ref)
        for (const fn of reauthListeners) fn(ref)
      }
      throw new ReauthRequired(ref)
    }
    if (!body.access_token) throw new Error(body.error_description ?? `token refresh failed (${status})`)
    if (body.refresh_token && body.refresh_token !== refreshToken) {
      setPassword(ref, JSON.stringify({ refreshToken: body.refresh_token }))
    }
    const expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000
    cache.set(ref, { token: body.access_token, expiresAt })
    return body.access_token
  })()
  inflight.set(ref, run)
  try {
    return await run
  } finally {
    inflight.delete(ref)
  }
}
