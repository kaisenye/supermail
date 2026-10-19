# Superhuman parity + Gmail/Outlook — scope and plan

Date: 2026-10-18 · Status: draft for review

## Goal

Match or beat Superhuman Mail on speed, keyboard UX and triage. Support Gmail and Outlook/M365 next to the
generic IMAP/SMTP accounts we already handle.

Superhuman was benchmarked from public sources only: the help center, the official shortcut PDF (v8), their
engineering blog, and talks. We did not unpack their app.

## Decisions (2026-10-18)

| Question | Decision |
|---|---|
| Gmail / Outlook transport | **IMAP + OAuth2 (XOAUTH2)** on the existing engine. Gmail IMAP extensions for labels and thread ids. Native Gmail API / Graph later, behind a provider interface, only if needed. |
| Audience | **You + a small team.** The Google OAuth app stays in testing mode (≤100 named users), plus a free Azure app registration. No CASA audit. |
| Server | **None. Local only.** Reminders and send-later fire only while the app or tray process is running. No read receipts. |
| AI | **Bring your own API key** (Claude by default), called from the main process through `src/core/services`. |

## Where we are (codebase facts)

- **Strong already:** local-first SQLite paint, IDLE push, connection pool, FTS5 + trigram search, threaded virtual list, compose, schedule + undo send, ⌘K palette, multi-account (one at a time), local tasks.
- **Blockers for this scope:**
  1. **Auth is password-only.** `AccountConfig.pass` is read by the pool, `verify.ts` and `smtp.ts`. There is no `provider` / `auth_type` on `accounts`.
  2. **Folder paths are hardcoded.**
     - `TRASH_PATHS` (`electron/ipc.ts`), `SENT_PATHS` (`flush.ts`, `workers.ts`), `'Drafts'`.
     - The g-chords, `OUTGOING_PATHS` and the sidebar `ORDER`.
     - `MailboxInfo.specialUse` is computed in `sync/imap.ts` and then dropped.
  3. **IPC uses the active account, not the account that owns the message.** This affects `message:body`, `toggleFlag` / `setFlag`, `folders:list` and search. It blocks a unified inbox and makes cross-account actions risky.
  4. **No archive / "Done" target.** Moves are trash-only (`messages:move`).
  5. **Shortcuts are defined in three places** — `App.tsx` bindings, palette actions and `ShortcutHelp` — and kept in sync by hand.
  6. **Snooze was reverted (139aa75 / fa61dd0).** It created mailboxes on a live account, and waking relied on UIDPLUS / SEARCH by Message-ID, which Exmail lacks.
- **Seams to reuse:**
  - The pipeline: `RawMessage` → `runPipeline` → `upsertMessage`.
  - The `FlagWriter` / `MoveWriter` optimistic queues.
  - `search.ts` operators.
  - The vault, which holds any secret string, including token JSON.
  - The unused `labels` / `message_labels` tables.
  - The `src/core/services` registry.

## Phases

Each phase gets its own implementation plan and ships on its own. The order is set by dependencies.

### Phase 0 — Foundations (unblocks everything)

1. **Folder roles.**
   - Migration adds `folders.role` (`inbox|sent|drafts|trash|junk|archive|all|null`).
   - Fill it from SPECIAL-USE, with name heuristics as the fallback (Exmail `Sent Messages` / `Deleted Messages`).
   - Replace every hardcoded path with `folderByRole(accountId, role)`.
2. **Account-owned IPC.** Handlers resolve the account from the message or folder id. The active account is only a UI default.
3. **Command registry** (`src/ui/commands.ts`). It is the single list of `{id, title, aliases, keys, when, run}` that drives `useHotkeys`, the ⌘K palette and `ShortcutHelp`. Superhuman's rule applies: every action has a name, a command and a shortcut.
4. **Generalized move queue.**
   - Extend `MoveWriter` to any target role or folder: archive, inbox, folder or label.
   - Keep ordering per thread, persist pending jobs, retry, and make the server call idempotent.
   - Undo works on every queued action.
5. **Speed budget.**
   - Time actions with `performance.now()` and log in dev any that take more than 100ms.
   - Prefetch and pre-sanitize the bodies of the next and previous threads.
   - Targets: thread open <50ms from cache, triage action <100ms on screen.

### Phase 1 — Gmail + Outlook sign-in (IMAP + OAuth2)

1. **Schema.** `accounts.provider` (`imap|gmail|microsoft`) and `accounts.auth_type` (`password|oauth2`). `AccountConfig` gets an `auth` union.
2. **OAuth flow** (`src/core/accounts/oauth.ts`):
   - The system browser, a loopback redirect on `127.0.0.1:<random>`, and PKCE (RFC 8252), all in main.
   - Google uses a "Desktop app" client with scopes `https://mail.google.com/ openid email`.
   - Microsoft uses a public client on the `common` tenant with scopes `https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email`.
   - Client ids come from env or build config; nothing is committed.
3. **Token provider.**
   - The refresh token lives in the vault.
   - Access tokens are refreshed early and on auth failure.
   - The pool / `verify` use imapflow `auth: {user, accessToken}`.
   - SMTP uses nodemailer `auth: {type: 'OAuth2', user, accessToken}`.
4. **Gmail specifics.**
   - Use `X-GM-THRID` as `thread_id` and `X-GM-MSGID` as the cross-folder dedupe key.
   - Write `X-GM-LABELS` into `message_labels`.
   - Sync INBOX, Sent, Drafts, Trash and Spam. User labels are shown from `X-GM-LABELS`, not synced as separate folders.
   - Archive = move to `[Gmail]/All Mail`.
   - Set `smtpSavesSent = true`.
5. **Outlook specifics.**
   - Use `smtp.office365.com:587` with STARTTLS. Fix the `secure` handling, which `sync/imap.ts` hardcodes to `true`.
   - Use the `\Archive` folder.
   - Set `smtpSavesSent = true`.
   - Give a clear error when a tenant has IMAP or SMTP AUTH disabled.
6. **Onboarding.** "Continue with Google", "Continue with Microsoft", and "Other (IMAP)", which is the current form.

**You need to set up** (I can't create accounts for you):
- A Google Cloud project, an OAuth consent screen in testing with your test users added, and a Desktop OAuth client.
- An Azure app registration as a public client, with a "Mobile and desktop" redirect to `http://localhost`.

### Phase 2 — Superhuman triage core

| Feature | Key | Notes |
|---|---|---|
| Done / Not done | `E` / `⇧E` | Move to the archive role. Exmail has no Archive folder, so it is created once only after the user confirms in Settings (this avoids the snooze mistake). `g e` opens the Done view. |
| Undo anything | `Z` | 10s, built on the Phase 0 queue. Replaces the separate send/trash toasts. |
| Remind me | `H`, `⌘⇧H` in compose | **Local only.** A `reminders` table keyed by account + Message-ID, with `remind_at` and `if_no_reply`. The message is hidden from the local inbox while pending and nothing is moved on the server. Natural-language time picker. `g h` opens the Reminders view. |
| Split inbox | `Tab` / `⇧Tab` | Splits are saved `search.ts` queries. Built in: Important / Other (Other = `List-Unsubscribe` / bulk headers or senders you never replied to), VIP, plus custom splits. Each shows a count. |
| Get me to zero | palette | Bulk Done for mail older than N days, optionally keeping unread or starred mail. Undo is available. |
| Inbox zero state | — | Empty-state art plus a local streak. |
| Move / label | `V` / `L` | Folder picker. Labels are Gmail only, through `X-GM-LABELS` STORE. |
| Mute | `⇧M` | A local rule: new replies in the thread skip the inbox. |
| Unsubscribe | `⌘U` | `List-Unsubscribe`: RFC 8058 one-click POST, or mailto. Always confirms first. |
| Spam | `!` | Move to the junk role. |
| Filters / select | `⇧U` `⇧S` · `⌘A` `⇧J/⇧K` | — |

### Phase 3 — Read / write power, and beating Superhuman

- **Thread:**
  - Expand one message or all (`O` / `⇧O`), next and previous message (`N` / `P`), page with `Space` / `⇧Space`.
  - `⌘O` opens links and attachments; `Tab` cycles through links.
- **Compose:**
  - Snippets with variables, inserted with `;` inline or the `⌘;` picker, from a local `snippets` table.
  - Instant Intro (`⌘⇧I`).
  - Send + Done (`⌘⇧↵`) and send later (`⌘⇧L`).
  - Field jumps (`⌘⇧O/C/B/S`).
- **Search:** add `OR`, `-term`, `"phrase"`, `in:`, `label:` and `before:` / `after:` to `search.ts`. Gmail accounts fall back to `X-GM-RAW` on the server.
- **Contact pane:** recent mail with this person and how often you've replied, all from the local DB with no third-party enrichment.
- **Where we beat Superhuman:**
  - A **unified inbox** across accounts (needs Phase 0.2).
  - `Ctrl+1–9` to switch accounts.
  - **Remappable shortcuts** (via the command registry).
  - Full offline history, not a 30-day cache.

### Phase 4 — AI (bring your own key)

- An API key in the vault and an `ai` service in `src/core/services`. The UI calls it only over IPC.
- Features, each opt-in:
  - Write with AI (`⌘J`: draft, shorten, fix, tone).
  - Instant Reply (3 suggestions).
  - Auto-summary line, generated on demand and cached in `messages.summary`.
  - Auto-labels / Important classifier feeding the splits, as a pipeline processor.
- A privacy note in Settings: message content goes to the provider you chose.

## Out of scope (for now)

- **Read receipts / open tracking.** Needs a tracking server, and it's a privacy liability.
- **Team features.** Shared conversations, comments, shared drafts.
- **Calendar.**
- **Mobile.**
- **Native Gmail API / Microsoft Graph backends.**
- **Public OAuth verification (CASA).**
- **Send-later and reminders while the app is fully quit.**
- **Third-party contact enrichment.**

## Risks

- **Gmail IMAP quirks:** label folders duplicate messages, and there are bandwidth limits. Mitigation: dedupe on `X-GM-MSGID`, and never sync label folders.
- **Microsoft tenants that disable IMAP / SMTP AUTH.** Mitigation: detect it and explain. Graph is the fallback later.
- **Google testing mode:** refresh tokens expire after 7 days for unverified apps in testing. Mitigation: a smooth re-auth prompt. Moving the app to "In production" without verification avoids the expiry but shows an unverified-app warning; this needs checking.
- **`App.tsx` (1190 lines) and `ipc.ts` (873) will grow.** Split them as Phase 0 touches them, not as a separate refactor.

## Verification (every phase)

- **Unit tests (vitest):**
  - PKCE / token refresh.
  - Folder-role resolution.
  - The command registry (no duplicate keys, the shortcut sheet is generated).
  - The split-query parser.
  - Reminder wake logic and natural-language dates.
  - Gmail label mapping.
  - List-Unsubscribe parsing.
- **Build checks:** `pnpm typecheck && pnpm test && pnpm build`, the same as CI.
- **Manual end-to-end in `pnpm dev`:** a Gmail test account, an Outlook.com account and the existing Exmail account. Check the same actions in each provider's webmail for two-way sync.
- **Perf:** the dev log shows no action over 100ms in a scripted triage of 50 threads.

## Next step

After review, write the Phase 0 implementation plan (superpowers:writing-plans), then Phase 1.
