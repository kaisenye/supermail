<p align="center">
  <img src="docs/brand/mark.png" width="64" height="64" alt="Supermail" />
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
  <a href="#ai-bring-your-own-key">AI</a> ·
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
| **Own your mail** | IMAP/SMTP, Gmail and Outlook. Credentials stay on your machine. |
| **Thin surface** | No cards-on-cards dashboard. One list. One thread. One command bar. |

Built for power users and small teams who want Superhuman-like speed without surrendering the mailbox.

> Tuned for [Tencent Exmail](https://exmail.qq.com/) defaults. Any IMAP/SMTP host works, and Gmail and Outlook sign in with OAuth.

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

**Accounts**
- Gmail and Microsoft 365 / Outlook via OAuth (no app passwords)
- Any IMAP/SMTP host with a password (Exmail, Fastmail, iCloud, …)
- Gmail syncs system folders only (INBOX, Sent, Drafts, Trash, Spam); labels are read and written with `X-GM-LABELS`

**Triage**
- Done / Not done with undo (`e` / `⇧E` / `z`); the undo window is adjustable (3 / 5 / 10 / 20 s)
- Split inbox with Important / Other / VIP and custom splits (`Tab` / `⇧Tab`)
- Filter chips (unread, needs reply, waiting, starred) and date grouping
- Remind me (`h`): local only, natural-language times; `⌘⇧H` in compose reminds if no reply
- Mute (`⇧M`), local only
- Move to folder (`v`) and Gmail labels (`l`)
- One-click unsubscribe (`⌘U`), always confirms first
- Get me to zero: bulk Done with undo, an inbox-zero state and a local streak

**Write path**
- Compose / reply / reply-all / forward, rich-text editor
- Recipient autocomplete on To / Cc / Bcc, mined from existing mail
- Signature with links and an inline logo; light / dark / system theme
- Attachments in and out, inline images sent as `multipart/related`
- Schedule send + undo send; undo on trash (same adjustable window)
- Optimistic star, read/unread, trash (IMAP write-back)

**Power**
- Workspace tabs, each with its own back / forward (`⌘T`, `⌘W`, `⌘1–9`, `⌃Tab`, `⌘[` / `⌘]`), restored after a restart
- Unified inbox across accounts (`g a`); `⌃1–9` switches account
- Remappable shortcuts (Settings → Shortcuts), with clashes refused
- Thread keys: `o` / `⇧O` expand, `n` / `p` step messages, `Space` pages, `Tab` cycles links, `⌘O` opens, `↵` replies all, and a position counter
- Snippets with `{variables}`: type `;name` then `⇥`, or pick with `⌘;`
- Send later (`⌘⇧L`), Send + Done (`⌘⇧↵`, one undo for both) and Instant Intro (`⌘⇧I`)
- Cancel a scheduled reply when someone replies first
- Search operators `OR`, `-word`, `"phrase"`, `in:`, `label:`, `before:`, `after:` on one search page (`/`) with Emails / Contacts / Tasks, plus Gmail server search
- Contact pane (`i`): recent mail with a person, from the local DB
- The whole mailbox offline: a background worker downloads every folder's headers (Settings → Offline history)

**Speed**
- Shared IMAP connection pool — actions settle in ~300–500ms instead of ~4s
- Paint from SQLite first; the network is always a background refresh

**Safety**
- Passwords and OAuth refresh tokens stored in the OS keychain, never in SQLite and never over IPC
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

### Gmail and Outlook

"Continue with Google / Microsoft" needs your own OAuth clients. Put these in
repo-root `.env.local` (gitignored). electron-vite bakes them in at build time,
so restart `pnpm dev` or rebuild after changing them.

```bash
MAIN_VITE_GOOGLE_CLIENT_ID=
MAIN_VITE_GOOGLE_CLIENT_SECRET=
MAIN_VITE_MS_CLIENT_ID=
```

- **Google:** create a Cloud project, configure the OAuth consent screen in
  *Testing* with yourself as a test user, enable the **Gmail API**, and create a
  **Desktop app** OAuth client. In Testing mode refresh tokens expire after 7 days;
  the app then shows a "sign in again" banner.
- **Microsoft:** register an Entra app for any tenant plus personal accounts. Add
  the *Mobile and desktop applications* platform with redirect
  `http://localhost/callback`, turn on **Allow public client flows**, and add the
  delegated permissions `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`,
  `openid`, `email`. Work or school tenants may have IMAP or SMTP AUTH disabled;
  the app explains it when so.
- Gmail syncs only its system folders (INBOX, Sent, Drafts, Trash, Spam).
  Labels are set from the label picker (`l`); Done moves to All Mail.

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
pnpm test        # vitest
pnpm build       # production bundle
```

---

## Shortcuts

| Key | Action |
|-----|--------|
| `j` / `k` | Move selection |
| `Enter` | Open thread |
| `x` | Toggle checkbox |
| `⇧J` / `⇧K` / `⌘A` | Extend selection down / up · select all |
| `u` | Toggle read / unread |
| `s` | Star |
| `⌫` | Trash |
| `e` / `⇧E` | Done / Not done |
| `z` | Undo |
| `h` | Remind me |
| `v` / `l` | Move / Gmail label |
| `⇧M` | Mute |
| `!` | Spam |
| `⌘U` | Unsubscribe |
| `Tab` / `⇧Tab` | Next / previous split |
| `⇧U` / `⇧R` / `⇧S` | Filter unread / needs reply / starred (in list) |
| `⇧D` | Group by date |
| `c` | Compose |
| `⌘,` | Settings |
| `⌘.` | Keyboard shortcuts |
| `r` / `↵` (or `⇧R`) / `f` | Reply / reply all / forward (in thread) |
| `o` / `⇧O` | Expand message / expand all (in thread) |
| `n` / `p` | Next / previous message (in thread) |
| `j` / `k` | Next / previous conversation (in thread) |
| `Space` / `⇧Space` | Page down / up (in thread) |
| `Tab` / `⇧Tab` | Next / previous link (in thread) |
| `⌘O` | Open selected link, else first attachment (in thread) |
| `i` | Contact pane (in thread) |
| `/` | Search page |
| `⌘K` | Command palette |
| `⌘J` / `⌘K` then `⇥` | Ask AI (Write with AI in compose) |
| `1` / `2` / `3` | Instant Reply (in thread) |
| `⌘T` / `⌘W` | New tab / close tab (`⇧⌘W` closes the window) |
| `⌘1`–`⌘9` | Jump to tab (`⌘9` = last) |
| `⌃Tab` / `⌃⇧Tab` | Next / previous tab |
| `⌘[` / `⌘]` | Back / forward |
| `⌃1`–`⌃9` | Switch account |
| `⌘↵` | Send (in compose) |
| `⌘⇧↵` | Send + Done (in compose) |
| `⌘⇧L` | Send later (in compose) |
| `⌘⇧I` | Instant Intro (in compose) |
| `⌘⇧O` / `⌘⇧C` / `⌘⇧B` / `⌘⇧S` | Jump to To / Cc / Bcc / Subject (in compose) |
| `⌘;` · `;name` then `⇥` | Insert a snippet (in compose) |
| `⌘⇧H` | Remind me if no reply (in compose) |
| `g` then `i`/`a`/`s`/`t`/`d`/`j`/`e`/`h` | Jump Inbox / All inboxes / Sent / Trash / Drafts / Junk / Done / Reminders |
| `Esc` | Clear selection · close thread · close palette |

---

## AI (bring your own key)

Optional, and off until you save a key in **Settings → AI**. Pick Anthropic or
OpenAI (each keeps its own key and model), then switch on the features you want.

| Feature | Key | What it does |
|---------|-----|--------------|
| Write with AI | `⌘J` (in compose) | Draft from a note, shorten, fix spelling and grammar, make it friendlier or more formal. Replaces the selection, or the text above the signature; `⌘Z` undoes it. |
| Instant Reply | `1` / `2` / `3` (in thread) | Three short replies, prepared in the background for new mail that needs one. Opens a reply to the sender with the text filled in; nothing is sent until you press Send. |
| Summary line | automatic, or ⌘K → Summarize conversation | One line at the top of a conversation when it opens, cached until a new message arrives. |
| Important / Other | — | Sorts new mail into the Important and Other splits and shows the reason in the thread. `ai:<category>` works in a custom split. |
| Ask AI | `⌘K` then `⇥`, or `⌘J` | A question answered from your local mail, with the messages it used listed as sources. |

- **Keys** are encrypted with the OS keychain (`safeStorage`), like account passwords, and never
  written to SQLite, settings or logs. The app only ever reports whether a key is saved.
- **Daily budget** in US dollars (default $1.00, up to $100), counted from the
  tokens each call uses. When it runs out AI stops until tomorrow; background
  work (sorting, prepared replies) stops at 80 % of it.
- **Background work** only looks at Inbox mail from the last 48 hours, skips
  newsletters and bulk mail, and never back-fills history.
- **Privacy:** when a feature runs, the sender, subject and text of the messages
  it works on are sent from this Mac straight to the provider with your key.
  Supermail has no server of its own. Ask AI sends the few local messages that
  match your question.

### Testing AI without a provider

A local mock answers both APIs on `127.0.0.1`, so nothing spends money:

```bash
pnpm ai:mock 4010
SUPERMAIL_ANTHROPIC_BASE_URL=http://127.0.0.1:4010 SUPERMAIL_OPENAI_BASE_URL=http://127.0.0.1:4010/v1 pnpm dev
```

Any key works against the mock; put `MOCK_401` in a prompt to see the rejected-key
error. A packaged build ignores both variables.

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
src/core/pipeline/ Parse + processors; queues background AI jobs
src/core/services/ai/ AI service: providers, budget, keys, mock server
src/core/ai/       AI mail features: write, summary, classify, replies, ask
src/core/triage/   Move planning, reminders, mute / VIP, unsubscribe, zero
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
- [x] Gmail and Outlook sign-in (OAuth2 on IMAP/SMTP)
- [x] Triage: Done, undo, split inbox, filter chips, Remind me, mute, labels, unsubscribe, Get me to zero
- [x] Power: tabs + history, unified inbox, remappable keys, thread keys, snippets, send later, cancel-on-reply, search page, contact pane, full offline history
- [x] AI, bring your own Anthropic or OpenAI key: write, Instant Reply, summary, Important / Other, Ask AI

PRs welcome. Keep the surface small.

---

## Security notes

- Never commit `.env.local`.
- Treat app passwords and OAuth client secrets like production secrets.
- Scheduled sends and reminders only act **while the app is running**.
- This is early software — use a dedicated / secondary mailbox if you’re cautious.

---

## License

[MIT](./LICENSE) © 2026 [Kaisen Ye](https://github.com/kaisenye)

---

<p align="center">
  <sub>Built to disappear into your hands.</sub>
</p>
