<p align="center">
  <img src="docs/brand/mark.svg" width="64" height="64" alt="Supermail" />
</p>

<h1 align="center">Supermail</h1>

<p align="center">
  <strong>Local-first desktop mail for people who live in their inbox.</strong><br />
  Keyboard-native. Offline-capable. No browser tabs. No cloud lock-in.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#why">Why</a> ·
  <a href="#shortcuts">Shortcuts</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#roadmap">Roadmap</a>
</p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg" />
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" />
  <img alt="stack" src="https://img.shields.io/badge/stack-Electron%20%2B%20React%20%2B%20SQLite-111111" />
</p>

---

## Why

Most “modern” mail clients are web apps in a trench coat: always online, always syncing the wrong things, always fighting your hands.

**Supermail** is the opposite posture.

| Principle | What it means |
|-----------|----------------|
| **Local-first** | Paint from SQLite immediately. Network is a background refresh, not a loading spinner. |
| **Keyboard-native** | `j`/`k`, `c`, `u`, `s`, `/`, `⌘K`, `⌫` — the list is a cockpit, not a mouse trap. |
| **Own your mail** | IMAP + SMTP to *your* server. Credentials stay on your machine. |
| **Thin surface** | No cards-on-cards dashboard. One list. One thread. One command bar. |

Built for power users and small teams who want Superhuman-like speed without surrendering the mailbox.

> Tuned for [Tencent Exmail](https://exmail.qq.com/) defaults. Any IMAP/SMTP host works.

---

## Features

**Read path**
- Envelope sync → background body backfill
- IMAP IDLE push: new mail, flag changes and deletions land in ~1–2s
- Two-way flag reconcile — read/star/delete done in webmail syncs back
- Union-find threading that survives servers which strip or truncate `References`
- Virtualized list, 50-per-page pagination, thread view with collapsed previews
- Sandboxed HTML bodies, inline `cid:` images, quoted-text collapsing
- Attachments: download, open, and inline preview (image / PDF / video / audio / CSV / text)
- Search: FTS5 with `from:` `to:` `cc:` `subject:` `body:` `is:unread` `is:starred`
  `has:attachment` operators, BM25 relevance, recency weighting, and a
  typo-tolerant trigram fallback when an exact query finds nothing

**Write path**
- Compose / reply / reply-all / forward, rich-text editor
- Recipient autocomplete on To / Cc / Bcc, mined from existing mail
- Signature with links and an inline logo; light / dark / system theme
- Attachments in and out, inline images sent as `multipart/related`
- Schedule send + 3s undo; 3s undo on trash
- Optimistic star, read/unread, trash (IMAP write-back)

**Speed**
- Shared IMAP connection pool — actions settle in ~300–500ms instead of ~4s
- Paint from SQLite first; the network is always a background refresh

**Safety**
- Passwords stored in the OS keychain, never in SQLite and never over IPC
- Received HTML sanitized in the main process
- Opaque iframe + CSP in the renderer; remote images blocked until you opt in
- Outbound HTML sanitized on paste *and* on send
- Password never written to SQLite or sent over IPC

---

## Install

**Requirements:** Node 20+, [pnpm](https://pnpm.io), macOS / Linux / Windows.

```bash
git clone https://github.com/kaisenye/supermail.git
cd supermail
pnpm install
pnpm dev
```

On first run the app walks you through connecting an account: enter an address
and it fills in the server settings for known providers, checks IMAP and SMTP
before saving anything, and stores the password in your OS keychain.

<details>
<summary><code>.env.local</code> (optional — pre-seed instead of the setup screen)</summary>

```bash
SUPERMAIL_EMAIL=you@yourdomain.com
SUPERMAIL_PASS=<app-specific password>
SUPERMAIL_NAME=Your Full Name

# optional — defaults are Exmail
# SUPERMAIL_IMAP_HOST=imap.exmail.qq.com
# SUPERMAIL_IMAP_PORT=993
# SUPERMAIL_SMTP_HOST=smtp.exmail.qq.com
# SUPERMAIL_SMTP_PORT=465
```

> Exmail rejects your normal login password. Use an **app-specific password** from the admin console.

Legacy `ROMO_*` env keys are still accepted. An existing `.env.local` is migrated
into the keychain on first launch; the file is left in place.

</details>

```bash
pnpm typecheck   # strict TypeScript
pnpm build       # production bundle
```

---

## Shortcuts

| Key | Action |
|-----|--------|
| `j` / `k` | Move selection |
| `Enter` | Open thread |
| `x` | Toggle checkbox |
| `u` | Toggle read / unread |
| `s` | Star |
| `⌫` | Trash |
| `c` | Compose |
| `,` | Settings |
| `r` / `⇧R` / `f` | Reply / reply-all / forward (in thread) |
| `/` or `⌘K` | Search & command palette |
| `⌘↵` | Send (in compose) |
| `g` then `i`/`s`/`t`/`d`/`j` | Jump Inbox / Sent / Trash / Drafts / Junk |
| `Esc` | Clear selection · close thread · close palette |

---

## Architecture

```
┌───────────── Renderer (React) ─────────────┐
│  List · Thread · Compose · ⌘K palette      │
│  Zustand · hotkeys · virtualized rows      │
└───────────────────┬────────────────────────┘
                    │ window.api (preload)
┌───────────────────▼────────────────────────┐
│  Main (Electron)                           │
│  SQLite (WAL + FTS5) · ImapFlow · SMTP     │
│  Sanitize · sync engine · outbox worker    │
└────────────────────────────────────────────┘
```

- **Main owns the dangerous stuff** — DB, credentials, IMAP/SMTP, HTML sanitization.
- **Renderer is UI only** — no raw credentials, no unsanitized HTML.
- **Optimistic writes** — SQLite first, IMAP in a background queue (`FlagWriter` / `MoveWriter`).
- **One connection pool** — every subsystem leases from `ImapPool` rather than dialing its own; IDLE keeps a dedicated connection because it must stay parked.

Sync defaults: last **760 days**, up to **20000** envelopes per folder, then incremental. Paging past the local tail pulls older UIDs off the server on demand.

> Exmail exposes only a limited window over IMAP. Widen it in the admin console
> (Settings → IMAP/SMTP) or the server simply will not offer older mail.

---

## Project layout

```
electron/          Main process, IPC, preload
src/core/store/    SQLite schema, migrations, repo
src/core/sync/     IMAP sync, IDLE, pool, reconcile, bodies, flag/move writers
src/core/send/     SMTP + outbox (schedule / undo)
src/core/pipeline/ Parse + processors (Stage 2 AI hooks)
src/ui/            React app
```

Agent notes for contributors: see [`CLAUDE.md`](./CLAUDE.md).

---

## Roadmap

- [x] Local-first IMAP sync + thread UI
- [x] Command palette & FTS search (operators, fuzzy, recency-weighted)
- [x] Compose / schedule / undo send
- [x] Bulk select · read/unread · trash
- [x] Historical sync + pagination (“load older” reaches past the sync window)
- [x] Attachment download, open, and inline preview
- [x] IMAP IDLE push + connection pooling
- [x] Settings: signature, logo, theme
- [x] Secure credential store (OS keychain via `safeStorage`)
- [x] Multi-account
- [ ] Snooze / split inbox
- [ ] AI triage (summaries, labels) — Stage 2 pipeline

PRs welcome. Keep the surface small.

---

## Security notes

- Never commit `.env.local`.
- Treat app passwords like production secrets.
- Scheduled sends only flush **while the app is running**.
- This is early software — use a dedicated / secondary mailbox if you’re cautious.

---

## License

[MIT](./LICENSE) © 2026 [Kaisen Ye](https://github.com/kaisenye)

---

<p align="center">
  <sub>Built to disappear into your hands.</sub>
</p>
