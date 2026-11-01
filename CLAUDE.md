# Sovo

Fast local-first mail client (IMAP/SMTP, Gmail, Outlook). North star: Superhuman-like speed — keyboard-first, instant search, compose, schedule send. Tuned for Tencent Exmail; works with any IMAP/SMTP host.

## Stages

- **Stage 1** — Local-first reader + write path (sync, search, compose, schedule). Current focus.
- **Stage 2** — AI (Phase 4, done): bring-your-own key for Anthropic or OpenAI. Write with AI, Instant Reply, summary line, Important / Other classifier, Ask AI. UI never imports AI modules.

## Architecture

| Process | Owns |
|---------|------|
| Main (`electron/`, `src/core/`) | SQLite, IMAP, SMTP, HTML sanitize, sync/outbox workers, AI service (`src/core/services/ai`), background AI worker |
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
4. Exmail quirks: STATUS skip, app-specific password. Special folders are found by role (`folders.role`, from SPECIAL-USE then names) — never by path. imapflow skips SELECT on a mailbox a pooled connection already has open and never refreshes its `uidNext`, so `fetchEnvelopes` NOOPs a reused mailbox and UID FETCHes rather than trust that UIDNEXT.
5. Threading: IMAP `ENVELOPE` has no References (RFC 3501) — fetch the header explicitly or replies each become their own thread. Exmail strips References from its own sent mail, so the thread root comes from a union-find over every id a message mentions, spanning INBOX and Sent. Each set is named by the `threadKey` most members derive; after that, `upsertMessage` joins new mail to the thread of any stored message it mentions.
6. Lists read `list_rows` (`src/core/store/listRows.ts`), one row per (folder, thread). Triggers on `messages` mark threads dirty in `list_dirty`; `refreshListRows()` rebuilds them before every list read, and `repairListDrift()` runs after each sync. Never GROUP BY messages for a list. List headers (`list_unsubscribe`, `bulk`) for pre-v18 mail are filled by `backfillListHeaders` (header lines only).
7. Remind me and mute are local: they set `list_rows.hidden` for Inbox rows and never move anything on the server. Exmail's Archive folder is only created from Settings → Done folder.
8. Navigation is recorded, not pushed: a store subscription in App turns every change of folder / split / chip / thread / search query into a workspace history step (`src/ui/workspace.ts`). Back, forward and tab switches call `applyView`, which must change the store before its first await.
9. The unified inbox (`UNIFIED_VIEW_ID`) reads `list_rows` with `(lr.account_id = ? AND lr.folder_id = ?) OR …` (`src/core/store/unified.ts`). Every list row carries `account_id`; thread reads, read/unread and compose pass the row's account to main. Anything that spans a mixed selection or every account checks each owner: `sync:runAll` keeps going past a failed account (`electron/syncAll.ts`), labels offer only what every owner has (`sharedLabelChoices`), and the scheduled list reads every account (`listScheduledOutbox`). An IDLE push (`mail:new`) carries its account's email; one from an account not on screen syncs that account (`pushSyncTarget`, `sync:runAccount`).
10. Full offline history (`electron/historyWorker.ts`) backfills one 500-header page per account per minute, folder order from `nextHistoryFolder`, until each synced folder has `history_complete`. A folder counts as synced once the forward pass has run (`forwardSynced`: local rows or `last_uid > 0`). `backfillFolder` is gap-aware (`backfillPlan`): it fetches the newest server uids missing locally at or below max(newest local uid, `last_uid`), so a Gmail server-search hit stored far below the window leaves no hole. With full history on the forward pass has no date floor (`forwardCutoff`); with it off, mail it drops reopens the folder's history (`reopenHistory`). It shares `runBackfillExclusive` (`electron/backfillLock.ts`) with Load older, so the two never run at once for an account; Load older waits for a worker page instead of failing. Each account is tried on its own (`createHistoryTick`), and a folder that throws sits out 15 minutes. `backfillFolder` stores nothing when the live UIDVALIDITY differs from `folders.uidvalidity`, and `setHistoryComplete` only sets the flag if the uidvalidity it read is still current. Off when `settings.full_history` is `'0'`.

## Pipeline

Ordered `Processor[]` mutate `MsgCtx.draft`. Failures skip except `parse`. FTS5 syncs via SQL triggers — not a processor. After a message is stored the pipeline queues background AI jobs (`enqueueForMessage`); provider calls never run inside `runPipeline`. Do not couple AI to UI.

## AI rules

- Keys live in the vault under `ai-anthropic` / `ai-openai`. Never SQLite, settings, logs, or an IPC reply; `ai:setKey` is write-only and the renderer only learns `hasKey`.
- All provider calls go through `Ai.run(feature, req)` (main passes `getAi()`; features take the `Ai` as a parameter so tests inject `fakeAi`), which checks the switch, the key and the daily budget (background work stops at 80 %) and records usage. Never call an SDK directly from a feature.
- Mail features live in `src/core/ai/`; prompts wrap mail in `<message>` tags with `asData()` and include `MAIL_IS_DATA`. Output is only shown, inserted into a draft the user edits, or stored as a label.
- Results are keyed by account + Message-ID (`ai_classifications`, `reply_options`); the summary lives in `messages.summary` of the thread's newest message, so a new reply makes it stale.
- Background AI is queued by the pipeline (`enqueueForMessage`) and run by `electron/aiWorker.ts`; only fresh (≤ 48 h), non-bulk Inbox mail; replies also skip notification senders and mail not addressed to the account. A run stopped by `auth` / `rate` pauses the queue 10 min, `budget` until local midnight (`electron/aiPause.ts`); a saved key or setting resumes it.
- Compose marks its signature and quote with `sovo-signature` / `sovo-quote` divs so Write with AI can find them (drafts saved before the rename carry `supermail-*`, still recognised). Drafts keep the markers; `stripComposeMarkers` removes them from the wire copy.
- The renderer never imports SDKs or `src/core/services/ai` / `src/core/ai` runtime code (`src/ui/aiBoundary.test.ts`). New `ai:*` handlers go in `electron/ipcAi.ts`.
- Tests use `fakeAi` or the mock server (`mockServer.ts`, `pnpm ai:mock`); nothing may call a real provider. `SOVO_ANTHROPIC_BASE_URL` / `SOVO_OPENAI_BASE_URL` are dev-only (ignored when packaged).
- Prices for the budget are in `src/core/services/ai/pricing.ts`; update them when a provider changes prices.

## Keyboard

Central dispatcher: `src/ui/hooks/useHotkeys.ts`. Modes: `list` | `thread` | `compose` | `modal` | `search`.

- Every action is declared once in `src/ui/commands.ts`; hotkeys, ⌘ chords, `g` sequences, ⌘K and the shortcut sheet are built from it. Add the command there, then its handler in `App.tsx`. Handlers run inside a 100ms budget that warns in dev.
- Single-key bindings go through `useHotkeys`. `g` sequences listen in the capture phase and consume their keys, so the second key never fires its own shortcut.
- Meta/Ctrl chords (Cmd+K, Cmd+Enter) use a dedicated listener — `useHotkeys` ignores modifiers on purpose.
- Compose/modal swallow list nav keys.
- A `KeySpec` may carry `modes`, so one key can mean different things per mode (`R` = reply all in a thread, needs-reply filter in the list). ⌘ chords may add `shift` (`⌘⇧H`).
- Keys inside an open picker or dialog (arrows, Enter, Esc) are local to that component, like `CommandPalette`. Palette commands run in `baseMode` (`src/ui/appMode.ts`), never `modal`.
- Triage keys in an open thread act on the open thread (`openThreadTarget`), never the list cursor.
- `KeySpec` kinds: `key`, `seq`, `mod` (⌘, Ctrl off macOS) and `ctrl` (the physical Control key: `⌃1–9` accounts, `⌃Tab` tabs). A `ctrl` chord is matched before a `mod` chord on the same key.
- Builders take the command list (`applyKeymap(COMMANDS, settings.keymap)`); never read `COMMANDS` directly in App. Numbered families (`account.1–9`, `tab.1–9`) set `sheet` so the shortcut sheet shows one row.
- Modes include `search` (the search page). Tab and history chords use `NAV_MODES` (list, thread, search) and stay off in compose.
- `⌘W` is close-tab: `electron/menu.ts` moves Close Window to `⇧⌘W`. Check `menu.ts` before taking any ⌘ chord the default menu might own.
- Thread keys drive `ThreadHandle` (`src/ui/views/Thread.tsx`); App holds no thread reading state.
- `⌘J` is AI everywhere: `compose.ai` (Write with AI, `external`, handled in `Compose.tsx`) in compose, `ai.ask` elsewhere. `⇥` inside ⌘K switches Commands ↔ Ask AI and is palette-local, not a command. `1`–`3` in a thread are `reply.option1–3` (Instant Reply).

## Schema

- Append-only migrations in `src/core/store/migrate.ts`. Never edit shipped migrations.
- Drafts: `messages.folder_id IS NULL`.
- `folders.role` (`inbox|sent|drafts|trash|junk|archive|all`) is reassigned every sync; one folder per role per account. Use `folderByRole`.
- Triage moves act on the whole thread in the current folder (`planMoves`); Done goes to `doneRole(provider)` (`archive`, or `all` on Gmail). `holdMove` applies them to SQLite at once and holds the IMAP MOVE for the undo window; backfill skips uids still queued in `move_jobs`.
- `move_jobs` holds IMAP moves not yet confirmed (with the source mailbox's UIDVALIDITY, so a replay after a renumber is dropped); `MoveWriter.resume()` replays them at boot and after each sync.
- Handlers that take message ids act on the owning account (`groupByAccount` / `ownerOf`), not the active one.
- Multi-account: every message/folder query must filter `account_id`. `thread_id` collides across accounts (same mailing list), so thread reads scope by account too.
- Outbox: `outbox` table for pending/scheduled/undo sends. **Scheduled send only flushes while the app is running.**
- `reminders` / `mutes` are keyed by account + Message-ID; `vip_senders`, `replied_senders` (trigger-filled) and `splits` back the Important/Other/VIP splits. Splits and chips are list-context `search.ts` queries (`is:needs-reply`, `is:waiting`, `is:important`…).
- `labels` / `message_labels` are account-scoped and hold Gmail X-GM-LABELS only.
- One undo window: `settings.undo_seconds` (3/5/10/20), read by main through `undoWindowMs`; IPC results carry `holdMs` and the renderer's single `UndoEntry` (`z`) uses it.
- `snippets` (global, plain text with `{variables}`), `tasks_fts` (trigger-kept), `outbox.cancel_on_reply` (the pipeline's `cancelAndNotify` cancels a pending scheduled reply when its thread gets a reply), `folders.history_complete` (full-history worker; `resetFolder` clears it).
- Settings keys added in Phase 3: `keymap`, `workspace`, `cancel_on_reply_default`, `contact_pane`, `full_history`.
- v21: AI tables (`ai_classifications`, `reply_options`, `ai_jobs`, `ai_usage`); `list_rows.ai_important` / `ai_category` feed `is:important` / `is:other` and `ai:<category>`. Turning the classifier off deletes verdicts.
- Settings keys added in Phase 4 (non-secret): `ai_provider`, `ai_model_anthropic`, `ai_model_openai`, `ai_daily_budget_usd`, `ai_write`, `ai_replies`, `ai_summary`, `ai_classify`, `ai_ask`.
- Signatures are per inbox: `signature:<accountId>`; an inbox without one falls back to the shared `signature` (from before). `remote_images` (`'0'` blocks remote images until Load images; anything else loads them). Editors keep a `<span>` text color only through `cleanPastedHtml(…, { keepColors: true })`; pastes drop it.

## Commands / env

```bash
pnpm install
pnpm dev          # electron-vite
pnpm typecheck
```

`.env.local` at repo root (see `.env.example`). Legacy `SUPERMAIL_*` and `ROMO_*` keys still work. OAuth client ids (`MAIN_VITE_GOOGLE_CLIENT_ID`, `MAIN_VITE_GOOGLE_CLIENT_SECRET`, `MAIN_VITE_MS_CLIENT_ID`) are baked into the main bundle at build time by electron-vite; restart `pnpm dev` after changing them.

## Roadmap

| Phase | Status | Scope |
|-------|--------|-------|
| Phase 0 | Done | Folder roles, owner-scoped IPC, persisted move queue, command registry, speed budget |
| Phase 1 | Done (live OAuth untested) | Gmail + Outlook sign-in via OAuth2 on IMAP/SMTP |
| A | Done | Quick search + Cmd+K command palette |
| B | Done | Compose / reply / SMTP send / Sent APPEND |
| C | Done | Schedule send + 3s undo send |
| D | Done | Selection + action bar; flags; archive/trash |
| Phase 2 | Done | Triage: list read model, Done, undo window, splits/chips, Remind me, mute, labels, unsubscribe, zero |
| Phase 3 | Done | Tabs + history, unified inbox, ⌃1–9, remappable keys, thread keys, snippets, send later / Send + Done / intro, cancel-on-reply, search operators + search page, contact pane, full history |
| Phase 4 | Done (live providers untested) | AI: write, instant reply, summary, classifier, ask |
| Later | — | Semantic search (embeddings) |

## Code map

- `electron/` — main, IPC, preload, boot state
- `src/core/store/` — db, schema, migrate, repo. The app was renamed from Supermail: `adoptLegacyData` copies `Supermail/supermail.db` + attachments into the `Sovo` folder once (default profile only). Keychain secrets are keyed to the app name, so they do not carry over; each account signs in again.
- `src/core/accounts/` — config, presets, keychain vault, connect verification
- `src/core/sync/` — IMAP sync, body fetch, flag writer (pools/watchers keyed per account)
- `src/core/send/` — SMTP, outbox flush
- `src/core/pipeline/` — parse + processors
- `src/core/services/ai/` — AI service and providers (gates, budget, keys, mock server)
- `src/core/ai/` — AI mail features (write, summary, classify, replies, ask, queue)
- `src/core/triage/` — move planning, reminders, local rules, unsubscribe, zero
- `electron/ipcTriage.ts` — Phase 2 handlers
- `electron/ipcPower.ts` — Phase 3 handlers
- `electron/ipcAi.ts` — Phase 4 `ai:*` wiring (bodies in `aiHandlers.ts`, Electron-free); `electron/aiWorker.ts` + `aiPause.ts` — background AI queue tick and pause
- `electron/menu.ts` — app menu
- `electron/historyWorker.ts`, `historyTick.ts`, `backfillLock.ts` — full history, one backfill per account
- `electron/syncAll.ts` — sync every account for the unified inbox
- `src/ui/` — App, views, Zustand store, hotkeys
