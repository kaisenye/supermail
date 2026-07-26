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
| **Keyboard-native** | `j`/`k`, `c`, `u`, `/`, `⌘K`, `e`, `#` — the list is a cockpit, not a mouse trap. |
| **Own your mail** | IMAP + SMTP to *your* server. Credentials stay on your machine. |
| **Thin surface** | No cards-on-cards dashboard. One list. One thread. One command bar. |

Built for power users and small teams who want Superhuman-like speed without surrendering the mailbox.

> Tuned for [Tencent Exmail](https://exmail.qq.com/) defaults. Any IMAP/SMTP host works.

---

## Features

**Read path**
- Envelope sync → background body backfill
- Virtualized lists, thread view, sandboxed HTML
- Full-text search (SQLite FTS5) via `/` or `⌘K`

**Write path**
- Compose / reply / reply-all
- SMTP send with display name
- Schedule send + 10s undo
- Optimistic star, read/unread, archive, trash (IMAP write-back)

**Safety**
- Received HTML sanitized in the main process
- Opaque iframe + CSP in the renderer
- Password never written to SQLite or sent over IPC

---

## Install

**Requirements:** Node 20+, [pnpm](https://pnpm.io), macOS / Linux / Windows.

```bash
git clone https://github.com/kaisenye/supermail.git
cd supermail
pnpm install
cp .env.example .env.local
# edit .env.local — email, app password, display name
pnpm dev
```

### `.env.local`

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

Legacy `ROMO_*` env keys are still accepted.

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
| `e` | Archive |
| `#` | Trash |
| `c` | Compose |
| `r` / `a` | Reply / reply-all (in thread) |
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

Sync defaults (stage 1): last **90 days**, up to **2000** envelopes per folder. Incremental after that. Full-history backfill is on the roadmap.

---

## Project layout

```
electron/          Main process, IPC, preload
src/core/store/    SQLite schema, migrations, repo
src/core/sync/     IMAP sync, bodies, flag/move writers
src/core/send/     SMTP + outbox (schedule / undo)
src/core/pipeline/ Parse + processors (Stage 2 AI hooks)
src/ui/            React app
```

Agent notes for contributors: see [`CLAUDE.md`](./CLAUDE.md).

---

## Roadmap

- [x] Local-first IMAP sync + thread UI
- [x] Command palette & FTS search
- [x] Compose / schedule / undo send
- [x] Bulk select · read/unread · archive/trash
- [ ] Infinite / historical sync (“load older”)
- [ ] Attachment download & open
- [ ] Secure credential store (keytar)
- [ ] Multi-account
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
