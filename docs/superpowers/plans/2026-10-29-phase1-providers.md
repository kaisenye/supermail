# Phase 1 — Gmail + Outlook sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users add Gmail and Outlook/Microsoft 365 accounts with "Continue with Google / Microsoft" (OAuth2 + PKCE), using the existing IMAP/SMTP engine. Every password-based IMAP/SMTP mailbox (Exmail, Fastmail, iCloud and others) must keep working unchanged.

**Architecture:**
- `AccountConfig.pass` becomes an `auth` union: a password, or OAuth2 with a vault reference.
- One function, `resolveAuth(config)`, turns either kind into the `auth` object that imapflow and nodemailer expect. For OAuth2 it returns a fresh access token, refreshed through `oauth.ts` from the refresh token kept in the vault.
- Sign-in runs in main:
  1. A loopback HTTP server listens on `127.0.0.1:<random port>`.
  2. The system browser opens the consent page.
  3. PKCE S256 and a `state` value protect the redirect.
  4. The email address is read from the `id_token`.
- Gmail-specific: sync only Gmail's system folders, skipping All Mail and the user-label folders, which each hold a duplicate of the same messages.
- Outlook-specific: correct hosts and ports, plus a clear error when the organisation has turned IMAP or SMTP AUTH off.

**Tech stack:**
- Electron 43 main process, imapflow 1.4 (`auth.accessToken`), nodemailer 9 (`auth.type: 'OAuth2'`).
- Node `http` and `crypto`, global `fetch`.
- vitest.

**Spec:** `docs/superpowers/specs/2026-10-18-superhuman-parity-design.md` (Phase 1).

**Deliberately deferred** (not needed to sign in, sync and send; they belong with the features that use them):
- `X-GM-THRID` threading. Gmail keeps References intact, so the existing union-find already threads Gmail correctly.
- `X-GM-LABELS` into `message_labels`. This goes with Phase 2 labels.
- Archive-to-All-Mail. This goes with Phase 2 Done.

**Conventions** (same as Phase 0):
- Core imports use `.js` suffixes.
- Migrations are append-only. The next one is **v17**.
- DB tests use `closeDb(); initDb(tmp)`.
- Use `npx --yes pnpm@10 …` if the global `pnpm` shim is broken; `pnpm` works now that `packageManager` is pinned.
- Commit messages use `[feat]`/`[fix]`/`[refactor]`/`[test]`/`[docs]`.

**Prerequisites the user sets up** (Task 0). These are needed only for the manual end-to-end test in Task 11; every other task is unit-tested without them:
- **Google:** a Cloud project with an OAuth consent screen in **Testing** with yourself as a test user, the **Gmail API** enabled (not called, but Google requires it for the `https://mail.google.com/` scope), and a **Desktop app** OAuth client.
- **Microsoft:** an Entra app registration, with supported accounts set to "Any Entra ID tenant + personal Microsoft accounts". Add the platform **Mobile and desktop applications** with redirect `http://localhost/callback`, turn on **Allow public client flows**, and add the delegated API permissions `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`, `openid`, `email`.
- **Repo `.env.local`** (gitignored): see Task 4 for the variable names.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/core/accounts/auth.ts` | create | `AccountAuth`, `MailProvider`, `resolveAuth()`, `smtpAuth()` |
| `src/core/accounts/auth.test.ts` | create | password and OAuth resolution |
| `src/core/accounts/oauth.ts` | create | provider endpoints and scopes, PKCE, auth URL, code exchange, refresh, id_token email, access-token cache, re-auth signal |
| `src/core/accounts/oauth.test.ts` | create | all pure parts plus refresh and cache, with a fake `fetch` |
| `src/core/accounts/oauthFlow.ts` | create | loopback server and browser hand-off, returning `{code, redirectUri, verifier}` |
| `src/core/accounts/oauthFlow.test.ts` | create | callback, state mismatch, error, timeout |
| `src/core/accounts/oauthClients.ts` | create | client ids from `import.meta.env` |
| `src/core/accounts/config.ts` | modify | `AccountConfig` gets `auth` and `provider`, losing `pass` |
| `src/core/accounts/manage.ts` | modify | save and load OAuth accounts |
| `src/core/accounts/presets.ts` | modify | Microsoft 365 preset; `providerPreset()` |
| `src/core/accounts/verify.ts` | modify | uses `resolveAuth` and `smtpAuth`; OAuth-specific error text |
| `src/core/accounts/verify.test.ts` | create | `explain()` branches |
| `src/core/store/migrate.ts`, `types.ts`, `repo.ts` | modify | v17 `accounts.provider`, `accounts.auth_type` |
| `src/core/sync/imap.ts` | modify | `createClient` becomes async and uses `resolveAuth`; implicit TLS only on 993 |
| `src/core/sync/pool.ts`, `idle.ts`, `syncEngine.ts`, `bodySync.ts` | modify | `await createClient`; pool reserves a slot while connecting |
| `src/core/sync/folderFilter.ts`, `.test.ts` | create | `shouldSyncFolder(provider, folder)` |
| `src/core/send/smtp.ts` | modify | `smtpAuth` |
| `electron/ipc.ts`, `electron/preload.ts`, `electron/main.ts` | modify | `account:oauth`, `account:reauth` event |
| `src/ui/views/Onboarding.tsx`, `src/ui/App.tsx`, `src/ui/styles/app.css` | modify | provider buttons; re-auth banner |
| `.env.example`, `README.md`, `CLAUDE.md` | modify | setup docs |

---

### Task 0: Baseline and prerequisites

- [ ] **Step 1: Check the baseline.** Run `pnpm typecheck && pnpm test`. Expect it clean, with 21 files / 159 tests passing. better-sqlite3 v13 ships N-API prebuilds that load in both Node and Electron, so no native rebuild is ever needed.
- [ ] **Step 2: Hand the OAuth setup to the user.** Give them the Google and Microsoft prerequisites above and keep going: Tasks 1–10 do not need them.

---

### Task 1: The `AccountAuth` type and `resolveAuth`

**Files:**
- Create: `src/core/accounts/auth.ts`, `src/core/accounts/auth.test.ts`
- Modify: `src/core/accounts/config.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// src/core/accounts/auth.test.ts
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
```

- [ ] **Step 2: Run the test and confirm it fails.** Run `pnpm exec vitest run src/core/accounts/auth.test.ts`. Expect FAIL: cannot resolve `./auth.js`.

- [ ] **Step 3: Implement `auth.ts`.** `getAccessToken` is created in Task 3, so the default token source is imported lazily to keep this task self-contained.

```ts
// src/core/accounts/auth.ts
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
```

- [ ] **Step 4: Change `AccountConfig` in `config.ts`.**
  - Add `import type { AccountAuth, MailProvider } from './auth.js'`.
  - Replace the field `pass: string` with:

```ts
  auth: AccountAuth
  /** Drives provider-specific sync rules (Gmail's duplicate label folders). */
  provider: MailProvider
```

  - In `loadAccountConfig`, replace the returned `pass,` with `auth: { kind: 'password', pass },` and add `provider: 'imap',`.

- [ ] **Step 5: Run the test.** Run `pnpm exec vitest run src/core/accounts/auth.test.ts`. It should pass. Typecheck now fails at every `config.pass`; Tasks 2 and 5 fix those. **Do not commit yet.** Tasks 1 and 2 land together in Task 2's commit.

---

### Task 2: Persist provider and auth type (v17), and save/load OAuth accounts

**Files:**
- Modify: `src/core/store/migrate.ts`, `src/core/store/types.ts`, `src/core/store/repo.ts`, `src/core/accounts/manage.ts`
- Test: `src/core/accounts/manage.test.ts` (create)

- [ ] **Step 1: Add migration v17.** Append it to `migrations`:

```ts
  // v17: how an account signs in. Existing rows are password IMAP accounts.
  (db) =>
    db.exec(`
ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'imap';
ALTER TABLE accounts ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'password';
`)
```

- [ ] **Step 2: Extend the types.** In `src/core/store/types.ts`, add to `interface Account`:

```ts
  provider: 'imap' | 'gmail' | 'microsoft'
  auth_type: 'password' | 'oauth2'
```

- [ ] **Step 3: Write the new columns in `upsertAccount` (`repo.ts`).** Replace the statement with:

```ts
  db.prepare(
    `INSERT INTO accounts (email, imap_host, imap_port, smtp_host, smtp_port, auth_ref, provider, auth_type)
     VALUES (@email, @imap_host, @imap_port, @smtp_host, @smtp_port, @auth_ref, @provider, @auth_type)
     ON CONFLICT(email) DO UPDATE SET
       imap_host = excluded.imap_host, imap_port = excluded.imap_port,
       smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port,
       auth_ref  = excluded.auth_ref,
       provider  = excluded.provider, auth_type = excluded.auth_type`
  ).run(a)
```

  - Update `src/core/accounts/index.ts` `bootstrapAccount` (dead code, but it must typecheck) to pass `provider: 'imap', auth_type: 'password'`.

- [ ] **Step 4: Write the failing test.**

```ts
// src/core/accounts/manage.test.ts
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
```

- [ ] **Step 5: Implement in `manage.ts`.**
  - Import `providerPreset` from `./presets.js` (Task 2b below adds it) and `type { MailProvider, OAuthProvider } from './auth.js'`.
  - In `toConfig`, replace `pass: input.pass,` with `auth: { kind: 'password', pass: input.pass },` and add `provider: 'imap',`.
  - In `saveAccount`, replace `setPassword(ref, config.pass)` with:

```ts
  if (config.auth.kind !== 'password') throw new Error('saveAccount is for password accounts')
  setPassword(ref, config.auth.pass)
```

  and add `provider: 'imap', auth_type: 'password'` to **both** `upsertAccount` calls.
  - Add after `saveAccount`:

```ts
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
```

  - Replace `configForAccount` with:

```ts
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
```

- [ ] **Step 6 (2b): Add `providerPreset` and the Microsoft 365 preset in `presets.ts`.**
  - Change the Outlook preset to OAuth-era hosts: `imapHost: 'outlook.office365.com'`, `smtpHost: 'smtp.office365.com'`, `smtpPort: 587`, and add `passwordHint: 'Microsoft no longer accepts passwords for IMAP. Use "Continue with Microsoft".'`.
  - Add at the bottom:

```ts
/** Server settings for an OAuth provider; independent of the address domain (Workspace, M365 tenants). */
export function providerPreset(provider: 'gmail' | 'microsoft'): ProviderPreset {
  if (provider === 'gmail') return PRESETS.find((p) => p.preset.id === 'gmail')!.preset
  return {
    id: 'microsoft',
    label: 'Microsoft 365',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    smtpSavesSent: true
  }
}
```

- [ ] **Step 7: Run the tests.** Run `pnpm exec vitest run src/core/accounts src/core/store`. All should pass, including `migrate.test.ts`, which asserts `user_version >= 14`. Typecheck still fails in `verify.ts`, `imap.ts` and `smtp.ts`; that is Task 5.

- [ ] **Step 8: Hold the commit.** Commit together with Task 5, once typecheck is green. Leave this staged.

---

### Task 3: `oauth.ts` — endpoints, PKCE, exchange, refresh, token cache

**Files:**
- Create: `src/core/accounts/oauth.ts`, `src/core/accounts/oauth.test.ts`, `src/core/accounts/oauthClients.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// src/core/accounts/oauth.test.ts
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
```

- [ ] **Step 2: Run the test and confirm it fails.** Run `pnpm exec vitest run src/core/accounts/oauth.test.ts`. Expect FAIL: cannot resolve `./oauth.js`.

- [ ] **Step 3: Create `oauthClients.ts`.**

```ts
// src/core/accounts/oauthClients.ts
import type { OAuthProvider } from './auth.js'

/**
 * OAuth client ids are baked in at build time from MAIN_VITE_* variables
 * (electron-vite loads .env / .env.local into import.meta.env for main).
 * Google's "Desktop app" secret is not confidential — Google documents that
 * installed apps cannot keep one — but its token endpoint still requires it.
 */
export function oauthClient(
  provider: OAuthProvider
): { clientId: string; clientSecret?: string } | null {
  if (provider === 'google') {
    const clientId = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID
    const clientSecret = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET
    return clientId ? { clientId, clientSecret } : null
  }
  const clientId = import.meta.env.MAIN_VITE_MS_CLIENT_ID
  return clientId ? { clientId } : null
}
```

`src/core/env.d.ts` currently only declares `*.sql?raw`. Append the env typings:

```ts
interface ImportMetaEnv {
  readonly MAIN_VITE_GOOGLE_CLIENT_ID?: string
  readonly MAIN_VITE_GOOGLE_CLIENT_SECRET?: string
  readonly MAIN_VITE_MS_CLIENT_ID?: string
}
```

`ImportMeta.env` comes from `vite/client`. If tsc reports that `env` is missing on `ImportMeta` in core, add `/// <reference types="vite/client" />` as the first line of `src/core/env.d.ts`, as `src/ui/env.d.ts` already does.

- [ ] **Step 4: Create `oauth.ts`.**

```ts
// src/core/accounts/oauth.ts
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

export function resetTokenCache(): void {
  cache.clear()
  inflight.clear()
}

/** A valid access token for the account behind `ref`, refreshing when close to expiry. */
export async function getAccessToken(
  ref: string,
  provider: OAuthProvider,
  fetchFn: typeof fetch = fetch
): Promise<string> {
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
      for (const fn of reauthListeners) fn(ref)
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
```

- [ ] **Step 5: Run the test and confirm it passes.** Run `pnpm exec vitest run src/core/accounts/oauth.test.ts`. Expect 10 passing.

- [ ] **Step 6: Hold the commit.** Commit with Task 5, since typecheck is still red from Task 1.

---

### Task 4: Loopback sign-in flow

**Files:**
- Create: `src/core/accounts/oauthFlow.ts`, `src/core/accounts/oauthFlow.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write the failing test.**

```ts
// src/core/accounts/oauthFlow.test.ts
import { describe, expect, it } from 'vitest'
import { waitForRedirect } from './oauthFlow.js'

/** Plays the browser: follows the auth URL's redirect_uri with the given query. */
function browser(query: (state: string) => string) {
  return async (url: string): Promise<void> => {
    const u = new URL(url)
    const redirect = u.searchParams.get('redirect_uri')!.replace('localhost', '127.0.0.1')
    const res = await fetch(`${redirect}?${query(u.searchParams.get('state')!)}`)
    await res.text()
  }
}

const buildUrl = (redirectUri: string, state: string) =>
  `https://idp.test/auth?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`

describe('waitForRedirect', () => {
  it('returns the code when state matches', async () => {
    const r = await waitForRedirect({
      host: '127.0.0.1',
      buildUrl,
      openUrl: browser((s) => `code=abc&state=${s}`)
    })
    expect(r.code).toBe('abc')
    expect(r.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  })

  it('uses localhost in the redirect for Microsoft, still listening on 127.0.0.1', async () => {
    const r = await waitForRedirect({
      host: 'localhost',
      buildUrl,
      openUrl: browser((s) => `code=x&state=${s}`)
    })
    expect(r.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/)
  })

  it('rejects a mismatched state', async () => {
    await expect(
      waitForRedirect({ host: '127.0.0.1', buildUrl, openUrl: browser(() => 'code=abc&state=evil') })
    ).rejects.toThrow(/state/)
  })

  it('reports a denied consent', async () => {
    await expect(
      waitForRedirect({
        host: '127.0.0.1',
        buildUrl,
        openUrl: browser((s) => `error=access_denied&state=${s}`)
      })
    ).rejects.toThrow(/access_denied/)
  })

  it('times out if the browser never comes back', async () => {
    await expect(
      waitForRedirect({ host: '127.0.0.1', buildUrl, openUrl: async () => {}, timeoutMs: 50 })
    ).rejects.toThrow(/timed out/)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails.** Run `pnpm exec vitest run src/core/accounts/oauthFlow.test.ts`. Expect FAIL: cannot resolve `./oauthFlow.js`.

- [ ] **Step 3: Implement.**

```ts
// src/core/accounts/oauthFlow.ts
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { randomState } from './oauth.js'

const PAGE = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>Supermail</title>` +
  `<body style="font:15px -apple-system,sans-serif;padding:48px">${msg}</body>`

/**
 * RFC 8252 loopback redirect. Listens on 127.0.0.1 on a random port, opens the
 * consent page in the system browser, and resolves with the authorisation
 * code. `host` only changes the redirect URI's spelling: Microsoft's portal
 * cannot register an http 127.0.0.1 URI, so it gets `localhost`, which
 * browsers resolve back to this listener (Entra ignores the port for it).
 */
export function waitForRedirect(opts: {
  host: '127.0.0.1' | 'localhost'
  buildUrl: (redirectUri: string, state: string) => string
  openUrl: (url: string) => Promise<void>
  timeoutMs?: number
}): Promise<{ code: string; redirectUri: string }> {
  const state = randomState()
  return new Promise((resolve, reject) => {
    let redirectUri = ''
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const fail = (msg: string) => {
        res.writeHead(400, { 'content-type': 'text/html' }).end(PAGE(`Sign-in failed: ${msg}`))
        finish(new Error(msg))
      }
      if (url.searchParams.get('state') !== state) return fail('state mismatch')
      const error = url.searchParams.get('error')
      if (error) return fail(error)
      const code = url.searchParams.get('code')
      if (!code) return fail('no code returned')
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(PAGE('Signed in. You can close this tab and return to Supermail.'))
      finish(null, code)
    })

    const timer = setTimeout(() => finish(new Error('Sign-in timed out')), opts.timeoutMs ?? 5 * 60_000)
    function finish(err: Error | null, code?: string): void {
      clearTimeout(timer)
      server.close()
      if (err) reject(err)
      else resolve({ code: code!, redirectUri })
    }

    server.on('error', (e) => finish(e))
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      redirectUri = `http://${opts.host}:${port}/callback`
      opts.openUrl(opts.buildUrl(redirectUri, state)).catch((e: Error) => finish(e))
    })
  })
}
```

- [ ] **Step 4: Run the test and confirm it passes.** Run `pnpm exec vitest run src/core/accounts/oauthFlow.test.ts`. Expect 5 passing.

- [ ] **Step 5: Document the env vars.** Append to `.env.example`:

```bash

# Optional — "Continue with Google / Microsoft". Baked in at build time.
# Google: Cloud console → OAuth client of type "Desktop app".
# MAIN_VITE_GOOGLE_CLIENT_ID=
# MAIN_VITE_GOOGLE_CLIENT_SECRET=
# Microsoft: Entra app registration (public client, redirect http://localhost/callback).
# MAIN_VITE_MS_CLIENT_ID=
```

- [ ] **Step 6: Hold the commit.** Commit with Task 5.

---

### Task 5: Plumb `resolveAuth` into IMAP, SMTP and verify

**Files:**
- Modify: `src/core/sync/imap.ts`, `pool.ts`, `idle.ts`, `syncEngine.ts`, `bodySync.ts`, `src/core/send/smtp.ts`, `src/core/accounts/verify.ts`
- Test: `src/core/accounts/verify.test.ts` (create)

- [ ] **Step 1: Make `createClient` async in `imap.ts`.**
  - Add `import { resolveAuth } from '../accounts/auth.js'`.
  - Replace the function head and options with:

```ts
export async function createClient(config: AccountConfig): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    // 993 is implicit TLS; 143 upgrades with STARTTLS. Hardcoding true broke
    // any server on 143.
    secure: config.imapPort === 993,
    auth: await resolveAuth(config),
```

  - Keep the rest of the body as it is.

- [ ] **Step 2: Reserve a pool slot while a connection is being set up (`pool.ts`).**
  - Add a field `private connecting = 0`.
  - In `acquire()`, replace the block from `if (this.entries.length < MAX_CONNECTIONS) {` through its `return entry` with:

```ts
    if (this.entries.length + this.connecting < MAX_CONNECTIONS) {
      // Count the slot before the first await: getting an OAuth token is async,
      // and two acquires racing past the check would open a fourth connection.
      this.connecting++
      let client: ImapFlow
      try {
        client = await createClient(this.config)
      } catch (err) {
        this.connecting--
        throw err
      }
      const entry: Entry = { client, busy: true }
      client.on('error', () => this.discard(entry))
      this.entries.push(entry)
      this.connecting--
      try {
        await client.connect()
      } catch (err) {
        this.entries = this.entries.filter((e) => e !== entry)
        throw err
      }
      this.startKeepalive()
      return entry
    }
```

  - Keep the existing comment about the unhandled `'error'` above `client.on('error', …)`.

- [ ] **Step 3: Await `createClient` in `idle.ts`.** In `connect()`, replace

```ts
    const client = createClient(this.config)
    this.client = client
```

with

```ts
    let client: ImapFlow
    try {
      client = await createClient(this.config)
    } catch {
      // No token (offline, or re-auth needed) — same backoff as a failed connect.
      this.scheduleReconnect()
      return
    }
    if (this.stopped) return
    this.client = client
```

  Change the import to `import type { ImapFlow } from 'imapflow'` if it isn't already there.

- [ ] **Step 4: Await at the remaining call sites.** In `syncEngine.ts` (3 sites: `syncAccount`, `repairThreading`, `backfillFolder`) and `bodySync.ts` (1 site), change `createClient(config)` to `await createClient(config)`. Every one of these is already inside an `async` function.

- [ ] **Step 5: SMTP (`smtp.ts`).** Import `smtpAuth` from `../accounts/auth.js`, and replace `auth: { user: config.email, pass: config.pass }` with `auth: await smtpAuth(config)`.

- [ ] **Step 6: Write the failing test for verify.**

```ts
// src/core/accounts/verify.test.ts
import { describe, expect, it } from 'vitest'
import type { AccountConfig } from './config.js'
import { explain } from './verify.js'

const ms: AccountConfig = {
  email: 'me@corp.com',
  name: null,
  imapHost: 'outlook.office365.com',
  imapPort: 993,
  smtpHost: 'smtp.office365.com',
  smtpPort: 587,
  smtpSavesSent: true,
  provider: 'microsoft',
  auth: { kind: 'oauth2', provider: 'microsoft', ref: 'acct-1' }
}

describe('explain', () => {
  it('tells a Microsoft user their organisation may have IMAP turned off', () => {
    const msg = explain({ authenticationFailed: true, responseText: 'AUTHENTICATE failed.' }, 'imap', ms)
    expect(msg).toMatch(/organisation/i)
    expect(msg).not.toMatch(/password/i)
  })

  it('names SMTP AUTH when SMTP is the leg that fails for Microsoft', () => {
    const msg = explain({ responseText: '535 5.7.139 SmtpClientAuthentication is disabled' }, 'smtp', ms)
    expect(msg).toMatch(/SMTP AUTH/)
  })

  it('tells a Google user to sign in again rather than fix a password', () => {
    const g: AccountConfig = { ...ms, provider: 'gmail', auth: { kind: 'oauth2', provider: 'google', ref: 'a' } }
    expect(explain({ authenticationFailed: true }, 'imap', g)).toMatch(/sign in again/i)
  })

  it('keeps the password hint for password accounts', () => {
    const pw: AccountConfig = { ...ms, provider: 'imap', auth: { kind: 'password', pass: 'x' } }
    expect(explain({ authenticationFailed: true }, 'imap', pw)).toMatch(/password/i)
  })
})
```

- [ ] **Step 7: Run the test and confirm it fails.** Run `pnpm exec vitest run src/core/accounts/verify.test.ts`. Expect FAIL, because `explain` is not exported.

- [ ] **Step 8: Update `verify.ts`.**
  - Export `explain` (`export function explain(…)`).
  - At the top of `explain`, after `const code = …`, insert:

```ts
  if (config.auth.kind === 'oauth2') {
    if (config.auth.provider === 'microsoft') {
      if (stage === 'smtp' && /SmtpClientAuthentication|5\.7\.139|535/i.test(raw)) {
        return 'Microsoft refused SMTP sign-in. Your organisation has SMTP AUTH turned off for this mailbox — an admin can enable it in the Microsoft 365 admin centre.'
      }
      if (e?.authenticationFailed || /AUTHENTICATE failed|AUTHENTICATIONFAILED/i.test(raw)) {
        return 'Microsoft refused IMAP sign-in. Your organisation may have IMAP turned off for this mailbox — an admin can enable it in the Microsoft 365 admin centre.'
      }
    } else if (e?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials/i.test(raw)) {
      return 'Google refused the sign-in. Sign in again, and make sure you allowed access to Gmail.'
    }
  }
```

  - In `verifyImap`, replace `auth: { user: config.email, pass: config.pass },` with `auth: await resolveAuth(config),`.
  - In `verifySmtp`, replace its `auth` line with `auth: await smtpAuth(config),`.
  - Import both from `./auth.js`.

- [ ] **Step 9: Check the whole build.** Run `pnpm typecheck && pnpm test && pnpm build`. Everything should be green. If typecheck still finds `config.pass`, grep for it with `grep -rn "\.pass\b" src electron` and convert each site the way the steps above do.

- [ ] **Step 10: Commit Tasks 1–5 together.**

```bash
git add src/core/accounts src/core/store src/core/sync src/core/send src/core/env.d.ts .env.example
git commit -m "[feat] OAuth2 account auth alongside passwords"
```

---

### Task 6: Gmail folder filter

**Files:**
- Create: `src/core/sync/folderFilter.ts`, `src/core/sync/folderFilter.test.ts`
- Modify: `src/core/sync/syncEngine.ts`, `src/core/sync/bodySync.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// src/core/sync/folderFilter.test.ts
import { describe, expect, it } from 'vitest'
import { shouldSyncFolder } from './folderFilter.js'

const f = (path: string, role: string | null) => ({ path, role: role as never })

describe('shouldSyncFolder', () => {
  it('syncs every folder on a plain IMAP server', () => {
    expect(shouldSyncFolder('imap', f('客户', null))).toBe(true)
    expect(shouldSyncFolder('imap', f('Archive', 'archive'))).toBe(true)
  })

  it('syncs only system folders on Gmail', () => {
    expect(shouldSyncFolder('gmail', f('INBOX', 'inbox'))).toBe(true)
    expect(shouldSyncFolder('gmail', f('[Gmail]/Sent Mail', 'sent'))).toBe(true)
    expect(shouldSyncFolder('gmail', f('[Gmail]/Drafts', 'drafts'))).toBe(true)
    expect(shouldSyncFolder('gmail', f('[Gmail]/Trash', 'trash'))).toBe(true)
    expect(shouldSyncFolder('gmail', f('[Gmail]/Spam', 'junk'))).toBe(true)
  })

  it('skips All Mail and user labels on Gmail, which duplicate the same messages', () => {
    expect(shouldSyncFolder('gmail', f('[Gmail]/All Mail', 'all'))).toBe(false)
    expect(shouldSyncFolder('gmail', f('[Gmail]/Starred', null))).toBe(false)
    expect(shouldSyncFolder('gmail', f('Receipts', null))).toBe(false)
  })

  it('syncs every folder on Microsoft, where folders are real folders', () => {
    expect(shouldSyncFolder('microsoft', f('Projects', null))).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails.** Run `pnpm exec vitest run src/core/sync/folderFilter.test.ts`. Expect FAIL.

- [ ] **Step 3: Implement.**

```ts
// src/core/sync/folderFilter.ts
import type { MailProvider } from '../accounts/auth.js'
import type { Folder } from '../store/types.js'

/**
 * Gmail exposes every label, plus All Mail, as an IMAP folder holding another
 * copy of the same messages. Syncing them would multiply storage, unread
 * counts, search hits and thread sizes, so a Gmail account syncs only its
 * system folders. Labels arrive later via X-GM-LABELS (Phase 2).
 */
const GMAIL_ROLES = new Set(['inbox', 'sent', 'drafts', 'trash', 'junk'])

export function shouldSyncFolder(
  provider: MailProvider,
  folder: Pick<Folder, 'path' | 'role'>
): boolean {
  if (provider !== 'gmail') return true
  return folder.role !== null && GMAIL_ROLES.has(folder.role)
}
```

- [ ] **Step 4: Apply the filter in sync.**
  - In `syncEngine.ts` `syncAccount`, change the sorted folder list to filter first:

```ts
    const folders = listFolders(accountId)
      .filter((f) => shouldSyncFolder(config.provider, f))
      .sort((a, b) => (a.role === 'inbox' ? -1 : b.role === 'inbox' ? 1 : 0))
```

  - Apply the same `.filter(...)` in `bodySync.ts` and in `repairThreading`'s folder list.
  - Import `shouldSyncFolder`.
  - Folder rows are still stored for every mailbox, so roles resolve and a future Done can target All Mail. They just aren't fetched.

- [ ] **Step 5: Run the tests and typecheck, then commit.**

```bash
pnpm exec vitest run src/core/sync && pnpm typecheck
git add src/core/sync
git commit -m "[feat] sync only Gmail's system folders"
```

---

### Task 7: The `account:oauth` IPC

**Files:**
- Modify: `electron/ipc.ts`, `electron/preload.ts`

- [ ] **Step 1: Add the handler in `ipc.ts`.** Add the imports:

```ts
import { authUrl, createPkce, exchangeCode, primeAccessToken } from '../src/core/accounts/oauth.js'
import { waitForRedirect } from '../src/core/accounts/oauthFlow.js'
import { saveOAuthAccount } from '../src/core/accounts/manage.js'
```

Merge `saveOAuthAccount` into the existing `manage.js` import. Then add after `'account:add'`:

```ts
  // "Continue with Google / Microsoft": consent in the system browser, then
  // the same verify-before-save path as a password account. Re-signing in to
  // an address already present updates it in place, which is also re-auth.
  ipcMain.handle('account:oauth', async (_e, provider: 'google' | 'microsoft') => {
    try {
      const { verifier, challenge } = createPkce()
      const { code, redirectUri } = await waitForRedirect({
        host: provider === 'google' ? '127.0.0.1' : 'localhost',
        buildUrl: (redirect, state) => authUrl(provider, redirect, challenge, state),
        openUrl: (url) => shell.openExternal(url)
      })
      const t = await exchangeCode(provider, code, verifier, redirectUri)
      if (!t.email) return { ok: false as const, error: 'The provider did not return an email address.' }

      const existing = storedAccounts().find((a) => a.email.toLowerCase() === t.email!.toLowerCase())
      const { account, config } = saveOAuthAccount({
        email: t.email,
        // The From: name lives in settings (displayNameFor) and is edited there.
        name: displayNameFor(existing?.id ?? -1),
        provider: provider === 'google' ? 'gmail' : 'microsoft',
        oauthProvider: provider,
        refreshToken: t.refreshToken
      })
      if (config.auth.kind === 'oauth2') primeAccessToken(config.auth.ref, t.accessToken, t.expiresAt)

      const check = await verifyAccount(config)
      if (!check.ok) {
        // A brand-new account that cannot connect must not linger half-added.
        if (!existing) {
          forgetAccount(account)
          deleteAccount(account.id)
        }
        return { ok: false as const, error: check.message ?? 'connection failed' }
      }
      // A re-auth replaces the live config so pools pick up the new token ref.
      if (getAccount(account.id)) {
        stopAccountWorkers(account.email)
        removeAccountFromState(account.id)
      }
      addAccountToState({ accountId: account.id, email: account.email, config })
      setActiveAccount(account.id)
      startAccountWorkers(config)
      return { ok: true as const, accountId: account.id, email: account.email }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })
```

Notes on that code:
- Add `displayNameFor` to the `manage.js` import. The From: name lives in settings, so a re-auth keeps the one the user set.
- `stopAccountWorkers` / `startAccountWorkers` / `getAccount` / `removeAccountFromState` / `addAccountToState` / `setActiveAccount` / `forgetAccount` / `deleteAccount` / `storedAccounts` are already imported in `ipc.ts`.

- [ ] **Step 2: Expose it in the preload.** Add next to `accountAdd`:

```ts
  accountOAuth: (
    provider: 'google' | 'microsoft'
  ): Promise<{ ok: true; accountId: number; email: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('account:oauth', provider),
  onReauthNeeded: (fn: (email: string) => void): (() => void) => {
    const h = (_e: unknown, email: string) => fn(email)
    ipcRenderer.on('account:reauth', h)
    return () => ipcRenderer.removeListener('account:reauth', h)
  },
```

- [ ] **Step 3: Typecheck, then commit.**

```bash
pnpm typecheck
git add electron/ipc.ts electron/preload.ts
git commit -m "[feat] sign in with Google or Microsoft from the main process"
```

---

### Task 8: Signal re-auth from main

**Files:**
- Modify: `electron/main.ts`

- [ ] **Step 1: Forward re-auth events to every window.** In `main.ts`, add `import { onReauthRequired } from '../src/core/accounts/oauth.js'` and `import { listAccounts as storedAccounts } from '../src/core/store/repo.js'`. Then, inside `app.whenReady().then(() => { … })` right after `registerIpc()`, add:

```ts
  // Google's Testing-mode refresh tokens expire after 7 days, and either
  // provider can revoke one. Tell the renderer which address needs a new
  // sign-in instead of letting sync fail silently.
  onReauthRequired((ref) => {
    const acct = storedAccounts().find((a) => a.auth_ref === ref)
    if (!acct) return
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('account:reauth', acct.email)
  })
```

  If `listAccounts` from `./state.js` is already imported under that name, use the alias as shown to avoid the clash.

- [ ] **Step 2: Typecheck, then commit.**

```bash
pnpm typecheck
git add electron/main.ts
git commit -m "[feat] tell the renderer when an account must sign in again"
```

---

### Task 9: Onboarding buttons

**Files:**
- Modify: `src/ui/views/Onboarding.tsx`, `src/ui/styles/app.css`

- [ ] **Step 1: Add OAuth state and the action** in `Onboarding`, after the existing `useState` lines:

```tsx
  const [oauthBusy, setOauthBusy] = useState<'google' | 'microsoft' | null>(null)

  const signIn = useCallback(
    async (provider: 'google' | 'microsoft') => {
      if (oauthBusy) return
      setOauthBusy(provider)
      setError(null)
      const res = await window.api.accountOAuth(provider)
      setOauthBusy(null)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setStage('syncing')
      onConnected()
    },
    [oauthBusy, onConnected]
  )
```

- [ ] **Step 2: Render the provider buttons above the password form.** Inside the `connect` stage, directly after the `</header>`, insert:

```tsx
        <div className="onboard-providers">
          <button
            type="button"
            className="onboard-provider-btn"
            disabled={!!oauthBusy || busy}
            onClick={() => void signIn('google')}
          >
            {oauthBusy === 'google' ? <Loader2 size={14} strokeWidth={2} className="onboard-spin" /> : null}
            Continue with Google
          </button>
          <button
            type="button"
            className="onboard-provider-btn"
            disabled={!!oauthBusy || busy}
            onClick={() => void signIn('microsoft')}
          >
            {oauthBusy === 'microsoft' ? <Loader2 size={14} strokeWidth={2} className="onboard-spin" /> : null}
            Continue with Microsoft
          </button>
          {oauthBusy && <p className="onboard-note">Finish signing in in your browser…</p>}
          <div className="onboard-divider">
            <span>or any IMAP mailbox</span>
          </div>
        </div>
```

  - The existing `<p className="onboard-error">` sits inside the `<form>`, below Advanced, so it is easy to miss after a browser sign-in. Also render the error inside the providers block, just above the divider: `{error && !email && <p className="onboard-error" role="alert">{error}</p>}`. The original element stays for password errors.

- [ ] **Step 3: Add styles to `app.css`.** These use the real tokens from `src/ui/styles/tokens.css`, so dark mode works without extra rules.

```css
.onboard-providers { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-4); }
.onboard-provider-btn {
  display: flex; align-items: center; justify-content: center; gap: var(--space-2);
  height: 36px; border-radius: var(--radius-md);
  border: 1px solid var(--border-strong); background: var(--bg-raised); color: var(--text-primary);
  font: inherit; font-size: var(--text-base); cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.onboard-provider-btn:hover:not(:disabled) { background: var(--surface-hover); }
.onboard-provider-btn:disabled { opacity: 0.6; cursor: default; }
.onboard-note { margin: 0; color: var(--text-tertiary); font-size: var(--text-sm); text-align: center; }
.onboard-divider { display: flex; align-items: center; gap: var(--space-2); color: var(--text-tertiary); font-size: var(--text-sm); }
.onboard-divider::before, .onboard-divider::after { content: ''; flex: 1; border-top: 1px solid var(--border); }
```

- [ ] **Step 4: Typecheck and build, then commit.**

```bash
pnpm typecheck && pnpm build
git add src/ui/views/Onboarding.tsx src/ui/styles/app.css
git commit -m "[feat] Continue with Google or Microsoft on the setup screen"
```

---

### Task 10: Re-auth banner

**Files:**
- Modify: `src/ui/App.tsx`, `src/ui/styles/app.css`

- [ ] **Step 1: Listen in `App.tsx` and render the banner.** Near the other `useState` hooks, add:

```tsx
  const [reauthEmail, setReauthEmail] = useState<string | null>(null)
  useEffect(() => window.api.onReauthNeeded(setReauthEmail), [])

  const reauth = useCallback(async () => {
    if (!reauthEmail) return
    // From the account itself, not the domain: Google Workspace and M365
    // tenants use custom domains.
    const acct = accounts.find((a) => a.email.toLowerCase() === reauthEmail.toLowerCase())
    const res = await window.api.accountOAuth(acct?.provider === 'gmail' ? 'google' : 'microsoft')
    if (res.ok) setReauthEmail(null)
    else setSyncError(res.error)
  }, [reauthEmail, accounts, setSyncError])
```

  - For that lookup, add `provider: MailProvider` to `AccountSummary` in `electron/state.ts`, set `provider: a.config.provider` in `getBootStatus()`, and add the same field to the preload `AccountSummary` type.
  - Render the banner as the first child inside the main pane, before the list header:

```tsx
      {reauthEmail && (
        <div className="reauth-banner" role="alert">
          <span>{reauthEmail} needs you to sign in again.</span>
          <button onClick={() => void reauth()}>Sign in</button>
          <button className="reauth-dismiss" onClick={() => setReauthEmail(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
```

- [ ] **Step 2: Style it** with the existing tokens, the same way as Task 9: a one-line bar, warning background, 8px padding, and buttons matching `.onboard-provider-btn`.

- [ ] **Step 3: Typecheck, test and build, then commit.**

```bash
pnpm typecheck && pnpm test && pnpm build
git add src/ui/App.tsx src/ui/styles/app.css electron/state.ts electron/preload.ts
git commit -m "[feat] prompt to sign in again when a token expires"
```

---

### Task 11: Docs and end-to-end check

**Files:**
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Update `README.md`.**
  - Under Install, add a "Gmail and Outlook" subsection that lists the three `MAIN_VITE_*` variables, says where to create each client (the prerequisites at the top of this plan), and notes that Google Testing mode requires signing in again every 7 days.
  - In Features, add "Gmail and Microsoft 365 via OAuth (no app passwords)".
  - In the badge row or Why table, change "IMAP + SMTP to *your* server" to "IMAP/SMTP, Gmail and Outlook".

- [ ] **Step 2: Update `CLAUDE.md`.**
  - Under **Architecture**, add:

```markdown
- Accounts authenticate with a password or OAuth2 (`AccountConfig.auth`). OAuth refresh tokens live in the vault as JSON under `auth_ref`; access tokens are in-memory only (`src/core/accounts/oauth.ts`). Always build IMAP/SMTP auth with `resolveAuth` / `smtpAuth` — never read a password off the config.
- Gmail syncs only its system folders (`shouldSyncFolder`); All Mail and label folders are duplicates.
```

  - Change the first line's "Fast local-first IMAP client" to "Fast local-first mail client (IMAP/SMTP, Gmail, Outlook)".

- [ ] **Step 3: Run the full check.** Run `pnpm typecheck && pnpm test && pnpm build`. All should be green.

- [ ] **Step 4: Manual end-to-end check** (needs the Task 0 prerequisites). Run `pnpm dev`.
  1. **Existing Exmail account:** still loads, syncs and sends.
  2. **Add account → Continue with Google:** the browser opens, you consent, the tab says "Signed in", the app adds the account and the inbox fills.
  3. **Check the Gmail folders:** `sqlite3 "<userData>/supermail.db" "select path, role from folders where account_id=<id>"`. Every folder is stored, but only INBOX, Sent, Drafts, Trash and Spam have messages.
  4. **Send from Gmail:** it arrives, and Gmail's web Sent shows exactly one copy.
  5. **Star and read in Supermail:** both show up in Gmail web, and the reverse direction works within about 60s.
  6. **Continue with Microsoft** using an outlook.com account: the same checks as 2–5. A work or school account whose tenant blocks IMAP shows the "organisation" message.
  7. **Re-auth:** revoke the app at myaccount.google.com → Security → Third-party access, then trigger a sync. The re-auth banner appears, and "Sign in" restores sync.
  8. **Restart the app:** OAuth accounts load from the vault with no prompt.

- [ ] **Step 5: Commit.**

```bash
git add README.md CLAUDE.md
git commit -m "[docs] Gmail and Outlook sign-in"
```

---

## Self-review notes

- **Spec coverage (Phase 1):**
  - 1.1 schema → Task 2.
  - 1.2 OAuth flow → Tasks 3–4 and 7.
  - 1.3 token provider → Tasks 3 and 5.
  - 1.4 Gmail: the folder rule is in Task 6; `X-GM-THRID`, labels and archive are deferred, and the header explains why.
  - 1.5 Outlook: hosts are in Task 2b, the `secure` fix in Task 5, the disabled-IMAP/SMTP error in Task 5.
  - 1.6 onboarding → Task 9.
  - Re-auth (from the spec's risks) → Tasks 8 and 10.
- **Tasks 1–5 share one commit,** because changing `AccountConfig` breaks typecheck until every `config.pass` site is converted.
- **Names used across tasks:**
  - `AccountAuth`, `MailProvider`, `OAuthProvider`, `TokenSource`, `resolveAuth`, `smtpAuth` (auth.ts).
  - `createPkce`, `randomState`, `authUrl`, `exchangeCode`, `emailFromIdToken`, `getAccessToken`, `primeAccessToken`, `invalidateAccessToken`, `onReauthRequired`, `ReauthRequired`, `OAuthNotConfigured`, `resetTokenCache` (oauth.ts).
  - `waitForRedirect` (oauthFlow.ts), `oauthClient` (oauthClients.ts), `saveOAuthAccount` / `NewOAuthAccountInput` / `configForAccount` (manage.ts), `providerPreset` (presets.ts), `shouldSyncFolder` (folderFilter.ts).
- **Known gap:** `invalidateAccessToken` is exported but not yet called. The plan relies on refreshing 5 minutes early. If live testing shows "AUTHENTICATE failed" with a cached token, call it from `pool.acquire`'s connect `catch` when `err.authenticationFailed` and the config is OAuth, then retry once.
