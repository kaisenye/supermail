# Supermail

Fast local-first mail client (IMAP/SMTP, Gmail, Outlook). North star: Superhuman-like speed — keyboard-first, instant search, compose, schedule send. Tuned for Tencent Exmail; works with any IMAP/SMTP host.

## Stages

- **Stage 1** — Local-first reader + write path (sync, search, compose, schedule). Current focus.
- **Stage 2** — AI (embed / summarize / classify) via pipeline processors + `src/core/services` registry. UI never imports AI modules.

## Architecture

| Process | Owns |
|---------|------|
| Main (`electron/`, `src/core/`) | SQLite, IMAP, SMTP, HTML sanitize, sync/outbox workers |
| Renderer (`src/ui/`) | React UI, Zustand, hotkeys |

- Talk only through `window.api` (preload `contextBridge`).
- Password stays in main memory, encrypted at rest in the OS keychain via `safeStorage` (`accounts.auth_ref` → `credentials/<ref>.bin`). Never SQLite, never IPC.
- Accounts authenticate with a password or OAuth2 (`AccountConfig.auth`). OAuth refresh tokens live in the vault as JSON under `auth_ref`; access tokens are in-memory only (`src/core/accounts/oauth.ts`). Always build IMAP/SMTP auth with `resolveAuth` / `smtpAuth` — never read a password off the config.
- Gmail syncs only its system folders (`shouldSyncFolder`); All Mail and label folders are duplicates.
- Sanitize **received** HTML in main before the renderer sees it. Outbound compose HTML is user-authored.

## Local-first rules

1. Paint from SQLite first; network refresh after.
2. Envelopes before bodies; body backfill is background.
3. Optimistic SQLite, then background IMAP (`FlagWriter` pattern for flags; same idea for moves/send).
4. Exmail quirks: STATUS skip, app-specific password. Special folders are found by role (`folders.role`, from SPECIAL-USE then names) — never by path.
5. Threading: IMAP `ENVELOPE` has no References (RFC 3501) — fetch the header explicitly or replies each become their own thread. Exmail strips References from its own sent mail, so the thread root comes from a union-find over every id a message mentions, spanning INBOX and Sent.

## Pipeline

Ordered `Processor[]` mutate `MsgCtx.draft`. Failures skip except `parse`. FTS5 syncs via SQL triggers — not a processor. Stage 2 appends processors; do not couple AI to UI.

## Keyboard

Central dispatcher: `src/ui/hooks/useHotkeys.ts`. Modes: `list` | `thread` | `compose` | `modal`.

- Every action is declared once in `src/ui/commands.ts`; hotkeys, ⌘ chords, `g` sequences, ⌘K and the shortcut sheet are built from it. Add the command there, then its handler in `App.tsx`. Handlers run inside a 100ms budget that warns in dev.
- Single-key bindings go through `useHotkeys`. `g` sequences listen in the capture phase and consume their keys, so the second key never fires its own shortcut.
- Meta/Ctrl chords (Cmd+K, Cmd+Enter) use a dedicated listener — `useHotkeys` ignores modifiers on purpose.
- Compose/modal swallow list nav keys.

## Schema

- Append-only migrations in `src/core/store/migrate.ts`. Never edit shipped migrations.
- Drafts: `messages.folder_id IS NULL`.
- `folders.role` (`inbox|sent|drafts|trash|junk|archive|all`) is reassigned every sync; one folder per role per account. Use `folderByRole`.
- `move_jobs` holds IMAP moves not yet confirmed (with the source mailbox's UIDVALIDITY, so a replay after a renumber is dropped); `MoveWriter.resume()` replays them at boot and after each sync.
- Handlers that take message ids act on the owning account (`groupByAccount` / `ownerOf`), not the active one.
- Multi-account: every message/folder query must filter `account_id`. `thread_id` collides across accounts (same mailing list), so thread reads scope by account too.
- Outbox: `outbox` table for pending/scheduled/undo sends. **Scheduled send only flushes while the app is running.**

## Commands / env

```bash
pnpm install
pnpm dev          # electron-vite
pnpm typecheck
```

`.env.local` at repo root (see `.env.example`). Legacy `ROMO_*` keys still work. OAuth client ids (`MAIN_VITE_GOOGLE_CLIENT_ID`, `MAIN_VITE_GOOGLE_CLIENT_SECRET`, `MAIN_VITE_MS_CLIENT_ID`) are baked into the main bundle at build time by electron-vite; restart `pnpm dev` after changing them.

## Roadmap

| Phase | Status | Scope |
|-------|--------|-------|
| Phase 0 | Done | Folder roles, owner-scoped IPC, persisted move queue, command registry, speed budget |
| Phase 1 | Done (live OAuth untested) | Gmail + Outlook sign-in via OAuth2 on IMAP/SMTP |
| A | Done | Quick search + Cmd+K command palette |
| B | Done | Compose / reply / SMTP send / Sent APPEND |
| C | Done | Schedule send + 3s undo send |
| D | Done | Selection + action bar; flags; archive/trash |
| Later | — | Full history sync, AI triage, snooze |

## Code map

- `electron/` — main, IPC, preload, boot state
- `src/core/store/` — db, schema, migrate, repo
- `src/core/accounts/` — config, presets, keychain vault, connect verification
- `src/core/sync/` — IMAP sync, body fetch, flag writer (pools/watchers keyed per account)
- `src/core/send/` — SMTP, outbox flush
- `src/core/pipeline/` — parse + processors
- `src/ui/` — App, views, Zustand store, hotkeys
