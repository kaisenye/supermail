# Scape: outside-in teardown

Date: 2026-10-29 · Scape desktop 0.60.1 (Electron 42.11.16, packaged by ToDesktop)

## Method

This was studied from the outside only:
- The app was used read-only on a signed-in Gmail account.
- Processes were inspected with `ps`, and the bundle's `Info.plist` was read.
- The local SQLite schema was looked at read-only (table names only, no mail content).
- Public sources were read: scape.app, the pricing page, the changelog, the security and privacy pages, tech.eu and Business Insider Japan.

The `app.asar` bundle and native binaries were not unpacked or decompiled.

## What it is

Scape is an AI-native email client for Mac. It comes from a YC S24 team of five in Stockholm and has $3.2M of seed funding.
- **Status:** launched from stealth on 2026-07-24 with a waitlist. The changelog has 7 entries in about 9 weeks, and in late October releases were coming almost daily.
- **Providers:** Google only (Gmail and Google Calendar). There is no IMAP. One Swedish article mentions Outlook, but nothing first-party confirms it.
- **Pricing:** Free costs $0. Plus is $20/month and adds automations, higher AI limits and unlimited quick drafts. Max is $100/month with roughly five times the AI of Plus.
- **Positioning:** "the intelligent inbox that works for you." Drafts are already written when you open a thread, and you approve every send.

## UI and UX observed

**Shell**
- A left sidebar has Compose, Search, Meetings and Agent at the top.
- Below that are the inbox views: Inbox (with an unread count), Reminders and Archive. A "show more" toggle reveals Sent, Starred, Drafts, All emails, Backlog, Spam and Trash.
- At the bottom are colour-dot labels (Important, Calendar, Notifications, Marketing), Invite team and Settings.
- **Workspace tabs** run across the top like browser tabs: ⌘T opens one, ⌘1–9 jumps to one, ⌃Tab cycles. Each tab is a view (Inbox, Settings, a thread), and its title follows the content.
- Back and forward history buttons sit in the titlebar.
- At top right are a send/agent icon and a calendar toggle (⌘⇧K).
- The bottom bar holds the Agent button and a history icon.

**List**
- Each row is one line: sender, thread count, AI label chips (Billing, Notifications, Important, plus custom ones such as USCIS, House and Auto), subject, snippet, then attachment and star icons and the date.
- Rows are grouped by date ("Last week", "October 2026").
- Filter chips sit at the top: Needs reply, Waiting and Unread, plus a Filter menu.
- Hovering a row shows inline actions: snooze, mark unread and archive.
- An unread row has a dot. A starred row shows a gold star.
- After you leave a thread, the list keeps its scroll position and cursor.

**Thread**
- Opens full width; there is no split pane.
- The top bar has back, a position counter ("15 / 201") with up/down buttons, more, snooze, mark unread and archive.
- Label chips under the subject can each be removed (×), and + adds one.
- There is a floating up/down control at the bottom right.

**Other views**
- **Command menu (⌘K):** "Search people or commands". Context actions are listed with their shortcuts, and **Tab switches to "Ask Scape"**, the AI.
- **Agent:** a chat that can be a popover, a sidebar or full screen, with chat tabs and history. It showed a spinner for more than 3s on an empty new chat.
- **Calendar panel:** a week strip and a day timeline with a now-line, shown beside the list.
- **Search:** a separate page with Emails, Meetings and Contacts scopes plus "Add filter".
- **Meetings:** Upcoming and Recordings, plus New Recording. Meetings are recorded on the Mac with no bot; transcription happens in the cloud (EU).
- **Settings:** Preferences (General, Personalization, Notifications, Meetings, Apps), Email (Labels, Signatures, Subscriptions) and Workspace (General, Members, Billing).
  - Undo send is 5s by default and can be changed.
  - "Cancel scheduled emails when someone replies."
  - "Newest email on top" inside a conversation.
  - Default mail app.
  - Global shortcut ⌥S.
  - ? shows the shortcut sheet.

**Keyboard map** (from the in-app sheet)
- It is close to Superhuman's: e archive · ⇧E to inbox · h snooze · s star · u read · # or ⌫ trash · ⇧⌫ restore · x select · ⌘A select all · ⌘U unsubscribe · l labels · r reply · ↵ reply all · f forward · c compose · j/k · Space/⇧Space scroll · ⌘↑/↓ jump to top/bottom.
- g sequences: i inbox, d drafts, t sent, e archive, h later, ! spam, # trash, a all, s starred.
- List: Tab/⇧Tab change inbox tab · ⇧F filter · ⇧R reply filter · ⇧U group by unread · ⇧D group by date · ⇧I group by inbox or archived.
- Compose: ⌘↵ send · ⌘⇧↵ send and archive · ⌘⇧O/C/B/S/M focus a field · ⌘⇧A attach · ⌘⇧I move contacts to Bcc · ⌘⇧H snooze · ⌘P proofread · ⌘⇧V paste as plain text · the usual formatting keys.
- Assistant: A opens it full screen · ⌘S saved view · ⌘⌥P/S/F popover, sidebar or full · ⌘N new chat · O then H history.
- History: ⌘[ and ⌘]. Undo with Z or ⌘Z. Redo with ⌘⇧Z.

## Architecture observed

- **Electron with several windows.** There are two renderers: a `main` window and a `dynamic-island` overlay window (presumably the meeting or recording pill). Custom schemes are `cid:`, `scape-remote-image:` and `scape-print:`. Sentry handles crash reporting.
- **Local-first SQLite.** `~/Library/Application Support/Scape/scape.db` is 138 MB in WAL mode for one Gmail account. Its table names show:
  - **Materialized read models** for instant lists: `emailListView`, `emailListViewRow`, `emailListViewDirty`, `computedEmailThread` and `computedEmailThreadLabel`.
  - **Precomputed counts:** `canonicalEmailCount*` and `emailUnreadLabelCount*`.
  - Repair tables for when those go stale: `readModelDriftState`.
  - **Body offload** (`emailBodyOffloadState`, `emailPendingBody`), so bodies load lazily or are evicted.
  - **FTS5:** `emails_fts`, plus a **unified search** index across email, meetings and contacts (`unified_search_fts`, `_unifiedSearchChunkIndex`).
  - **Precomputed AI:** `emailReplyOptions` (suggested replies), `emailClassificationReasoning`, `emailDraftBranchingPlan` and `emailDraftAttachmentSuggestion`.
  - Assistant and memory tables: `assistantThread`, `assistantToolCall`, `memory` and `mcpConnector`.
  - Outboxes, such as `meetingLiveChunkOutbox`, and `_syncState`.
- **AI runs in the cloud.** Data is hosted in the EU by default. LLM vendors aren't named, and some inference may go to the US.

## Performance (one MacBook, outside measurement)

| Metric | Scape |
|---|---|
| Bundle size | 566 MB |
| Process start after `open -a` | about 0.1 s |
| Main renderer spawned | about 2.3 s, from one clean run; one earlier run was discarded |
| Memory during startup | 1.2–1.4 GB RSS across 6 processes, 35–77% CPU |
| Memory warm and idle | about 930 MB RSS, about 3% CPU |
| Main process RSS | about 550 MB. SQLite and sync likely run in main |
| Agent panel first load | spinner for more than 3 s |

Not measured: input-to-paint latency, which needs instrumentation inside the app. Supermail's own numbers haven't been taken yet, so compare with `pnpm build && pnpm start`.

## What Supermail should take from this

1. **Precomputed list read model.** A `list_rows` table holds one row per thread per view with its counts, and is kept up to date by dirty flags. It replaces grouping at query time, which is how the list paints in one indexed read. Scape's `emailListViewRow` and `readModelDriftState` show the pattern, including the repair pass.
2. **Workspace tabs and history.** ⌘T, ⌘1–9, ⌘[ and ⌘]. These are cheap with the command registry and a strong daily-use feature that Superhuman doesn't have.
3. **Filter chips and grouping keys** (Needs reply, Waiting, Unread; ⇧U, ⇧D, ⇧R). They fit into Phase 2 splits as saved queries.
4. **Tab in ⌘K to ask AI**, and **↵ as reply-all in a thread**. Both are small and reuse the palette.
5. **"Cancel scheduled send when someone replies"** and **an adjustable undo window.** Both are small, both are local, and both map onto the existing outbox.
6. **Unified search across mail, contacts (and later tasks).** One FTS5 table with a `kind` column.
7. **Precomputed AI** (Phase 4). Store suggested replies and classification reasons per message, generated in the background, so drafts are already there when a thread opens.

Where we already beat it, or can:
- IMAP, Exmail and Outlook support (Scape is Gmail only).
- Mail data that never leaves the machine (Scape uses cloud AI).
- No account or waitlist.
- A unified inbox planned across providers.
- Smaller footprint; to be measured.

Things to avoid:
- A slow first load for the assistant.
- Running sync and SQLite in the main process at around 550 MB RSS. Keep heavy work off the main event loop, or measure ours first.
