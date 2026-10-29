import { beforeEach, describe, expect, it, vi } from 'vitest'

const secrets = new Map<string, string>()
vi.mock('./vault.js', () => ({
  getPassword: (ref: string) => secrets.get(ref) ?? null,
  setPassword: (ref: string, v: string) => void secrets.set(ref, v)
}))
vi.mock('./oauthClients.js', () => ({
  oauthClient: (p: string) =>
    p === 'google' ? { clientId: 'g-id', clientSecret: 'g-secret' } : { clientId: 'm-id' }
}))

import {
  ReauthRequired,
  authUrl,
  createPkce,
  emailFromIdToken,
  exchangeCode,
  getAccessToken,
  onReauthRequired,
  resetTokenCache
} from './oauth.js'

function jwt(claims: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`
}

function fakeFetch(body: object, status = 200) {
  const calls: { url: string; body: string }[] = []
  const fn = vi.fn(async (url: string, init: { body: URLSearchParams }) => {
    calls.push({ url, body: init.body.toString() })
    return new Response(JSON.stringify(body), { status })
  })
  return { fn: fn as unknown as typeof fetch, calls }
}

beforeEach(() => {
  secrets.clear()
  resetTokenCache()
})

describe('PKCE', () => {
  it('makes an S256 challenge from a 43+ char verifier', async () => {
    const { verifier, challenge } = createPkce()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    const { createHash } = await import('crypto')
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })
})

describe('authUrl', () => {
  it('asks Google for offline mail access with PKCE', () => {
    const u = new URL(authUrl('google', 'http://127.0.0.1:5000/callback', 'chal', 'st'))
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(u.searchParams.get('client_id')).toBe('g-id')
    expect(u.searchParams.get('scope')).toBe('https://mail.google.com/ openid email')
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('prompt')).toBe('consent')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('state')).toBe('st')
  })

  it('asks Microsoft for IMAP + SMTP on the common tenant', () => {
    const u = new URL(authUrl('microsoft', 'http://localhost:5000/callback', 'chal', 'st'))
    expect(u.origin + u.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
    )
    expect(u.searchParams.get('scope')).toContain('https://outlook.office.com/IMAP.AccessAsUser.All')
    expect(u.searchParams.get('scope')).toContain('https://outlook.office.com/SMTP.Send')
    expect(u.searchParams.get('scope')).toContain('offline_access')
  })
})

describe('emailFromIdToken', () => {
  it('reads email, falling back to preferred_username (Microsoft work accounts)', () => {
    expect(emailFromIdToken(jwt({ email: 'a@gmail.com' }))).toBe('a@gmail.com')
    expect(emailFromIdToken(jwt({ preferred_username: 'b@corp.com' }))).toBe('b@corp.com')
    expect(emailFromIdToken(jwt({}))).toBeNull()
  })
})

describe('exchangeCode', () => {
  it('posts the code + verifier and returns tokens and email', async () => {
    const f = fakeFetch({
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 3600,
      id_token: jwt({ email: 'me@gmail.com' })
    })
    const t = await exchangeCode('google', 'CODE', 'VER', 'http://127.0.0.1:1/callback', f.fn)
    expect(t).toMatchObject({ accessToken: 'a', refreshToken: 'r', email: 'me@gmail.com' })
    expect(f.calls[0].url).toBe('https://oauth2.googleapis.com/token')
    const sent = new URLSearchParams(f.calls[0].body)
    expect(sent.get('grant_type')).toBe('authorization_code')
    expect(sent.get('code_verifier')).toBe('VER')
    expect(sent.get('client_secret')).toBe('g-secret')
  })

  it('throws when no refresh token comes back', async () => {
    const f = fakeFetch({ access_token: 'a', expires_in: 3600, id_token: jwt({ email: 'x@y.z' }) })
    await expect(exchangeCode('google', 'C', 'V', 'r', f.fn)).rejects.toThrow(/refresh token/)
  })
})

describe('getAccessToken', () => {
  it('refreshes once, then serves from cache until near expiry', async () => {
    secrets.set('acct-1', JSON.stringify({ refreshToken: 'r-1' }))
    const f = fakeFetch({ access_token: 'a-1', expires_in: 3600 })
    expect(await getAccessToken('acct-1', 'google', f.fn)).toBe('a-1')
    expect(await getAccessToken('acct-1', 'google', f.fn)).toBe('a-1')
    expect(f.calls).toHaveLength(1)
    expect(new URLSearchParams(f.calls[0].body).get('refresh_token')).toBe('r-1')
  })

  it('stores a rotated refresh token (Microsoft rotates them)', async () => {
    secrets.set('acct-2', JSON.stringify({ refreshToken: 'old' }))
    const f = fakeFetch({ access_token: 'a', refresh_token: 'new', expires_in: 3600 })
    await getAccessToken('acct-2', 'microsoft', f.fn)
    expect(JSON.parse(secrets.get('acct-2')!).refreshToken).toBe('new')
  })

  it('signals re-auth when the refresh token is rejected', async () => {
    secrets.set('acct-3', JSON.stringify({ refreshToken: 'dead' }))
    const seen: string[] = []
    const off = onReauthRequired((ref) => seen.push(ref))
    const f = fakeFetch({ error: 'invalid_grant' }, 400)
    await expect(getAccessToken('acct-3', 'google', f.fn)).rejects.toBeInstanceOf(ReauthRequired)
    expect(seen).toEqual(['acct-3'])
    off()
  })

  it('shares one refresh between concurrent callers', async () => {
    secrets.set('acct-4', JSON.stringify({ refreshToken: 'r' }))
    const f = fakeFetch({ access_token: 'a', expires_in: 3600 })
    await Promise.all([1, 2, 3].map(() => getAccessToken('acct-4', 'google', f.fn)))
    expect(f.calls).toHaveLength(1)
  })
})
