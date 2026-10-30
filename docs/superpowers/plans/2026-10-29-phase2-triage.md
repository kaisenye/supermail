# Phase 2 — Superhuman triage core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Superhuman-style triage on every account: Done / Not done, undo anything with an adjustable window, filter chips, date grouping, Remind me, split inbox, Get me to zero, an inbox-zero state, move / label, mute, unsubscribe, spam and the starred filter. All of it sits on a precomputed list read model so every view paints in one indexed read.

**Architecture:**
- **List read model** *(Scape)*. A `list_rows` table holds one row per (folder, thread) with the newest message id, date, counts and the thread state the filters need: `last_from_me`, `bulk`, `hidden`. SQL triggers on `messages` mark `(account_id, thread_key)` dirty in `list_dirty` on every insert, delete, move, flag change or rethread. `refreshListRows()` rebuilds only the dirty threads before any list read. `repairListDrift()` runs after each sync and rebuilds any folder whose counts disagree with a fresh GROUP BY.
- **Views are queries.** Splits and chips are `search.ts` queries parsed in a new *list* context, where `is:` operators read thread state from `list_rows` (`is:unread`, `is:needs-reply`, `is:waiting`, `is:important`, `is:other`, `is:vip`). `listView(folderId, { query })` and `countView()` are the only list reads.
- **Local triage state** lives in SQLite and never touches the server: `reminders` (keyed by account + Message-ID), `mutes`, `vip_senders`, `splits`. Hiding is computed into `list_rows.hidden` for Inbox rows only.
- **Server-side triage** goes through the Phase 0 move queue. `planMoves()` expands a list row to every message of its thread in that folder and maps Done to the account's archive role (`all` on Gmail). `holdMove()` applies the moves to SQLite at once and holds the IMAP MOVE for the undo window, which now comes from one setting (`undo_seconds`) that main reads for both moves and sends.
- **One undo slot.** The renderer keeps a single `UndoEntry`; every undoable action replaces it, `z` and the toast both run it.
- **Gmail labels** arrive with `X-GM-LABELS` on the envelope fetch and on reconcile, are stored in account-scoped `labels` / `message_labels`, and are written back with `STORE ±X-GM-LABELS` through the existing `FlagWriter`.
- New main-process handlers go in `electron/ipcTriage.ts`, so `electron/ipc.ts` (988 lines) stops growing; only the move hold stays in `ipc.ts` because it owns `pendingMoves`.

**Tech stack:**
- Electron 43, React 19, TypeScript (strict, `noUnusedLocals`), Zustand.
- better-sqlite3 13 (bundled SQLite 3.53: window functions, FTS5, JSON1), imapflow 1.4 (`labels: true` fetch, `useLabels` store, `mailboxCreate`), mailparser 3, vitest 4.

**Spec:** `docs/superpowers/specs/2026-10-18-superhuman-parity-design.md` (Phase 2, including every *(Scape)* item). Scape detail: `docs/research/2026-10-29-scape-teardown.md`.

**Decisions already made (do not reopen):**
- Exmail has no Archive folder. One is created **only** after the user confirms in Settings → Done folder. Done without one shows an error pointing there.
- Remind me is **local only**. Nothing is moved on the server; the thread is hidden from the local Inbox while the reminder is pending.
- Unsubscribe **always confirms first**.
- Gmail labels use `X-GM-LABELS`.
- The undo window (3 / 5 / 10 / 20 s) is one setting shared by main's undo-move hold, the send delay and the toast.

**Deliberately not in Phase 2** (spec Phase 3+): cancel-scheduled-send-on-reply, workspace tabs, thread position counter, `↵` reply-all, OR / `-term` / `label:` search, unified search, snippets, Gmail `X-GM-THRID`.

**Conventions** (same as Phases 0 and 1):
- Core imports use `.js` suffixes (`'./db.js'`). UI imports have no suffix (`'./store'`); UI tests import with `.js`.
- Migrations are append-only (`src/core/store/migrate.ts`). The next one is **v18** and this plan adds only v18.
- DB tests call `closeDb(); initDb(join(mkdtempSync(join(tmpdir(), 'x-')), 't.db'))` in `beforeEach` (see `src/core/store/threadedList.test.ts`).
- Run one test file with `pnpm exec vitest run <path>`. Every task ends with `pnpm typecheck && pnpm test` green.
- Every new keyboard action is declared in `src/ui/commands.ts` and handled in `App.tsx` (or, for compose-only chords, declared there with `external: true` and handled in `Compose.tsx`). Keys *inside* an open picker or dialog (arrows, Enter, Esc) are local to that component, like `CommandPalette`.
- The renderer never imports runtime code from `src/core`; it talks to main through `window.api` only. Pure UI helpers live in `src/ui/`.
- Commit messages use `[feat]` / `[fix]` / `[refactor]` / `[test]` / `[docs]` and a lower-case summary. **Skip the commit steps if you were told not to commit** (the shared working tree for automated runs is one such case); leave the changes in the tree.

---

## As built (2026-10-29)

All tasks are implemented; `pnpm typecheck`, `pnpm test` (**60 files / 418 tests**, baseline was 29 / 204) and `pnpm build` are green. Commit steps were skipped (shared working tree), and the manual end-to-end check (Task 11 Step 4) has not been run. Deviations from the plan:

- **Two migrations, not one.** v18 is as planned. v19 rewrites the `list_dirty_au` trigger: SQLite applies the outer statement's conflict policy inside triggers, so under `upsertMessage`'s `ON CONFLICT DO UPDATE` its `INSERT OR IGNORE` became ABORT and threw when a thread was already dirty. It now inserts with `NOT EXISTS`.
- **Extra core modules.** `triage/archiveSetup.ts` (Settings offers to create Archive only when the Done role is `archive`; Gmail gets a "show All Mail in IMAP" hint instead). `triage/moveUndo.ts` (`rollbackMoves`: undoing a held move is one transaction, restores the fired reminders the move dropped, and first deletes any copy a backfill re-inserted at the source uid). `sync/headerBackfill.ts` (`backfillListHeaders` fills list headers for mail synced before v18, header lines only). `moveJobs.queuedSourceUids` + `syncEngine.backfillPage` make backfill skip uids still mid-move, so Done rows do not reappear.
- **Threading fixes found on the way.** `rethread.assignThreads` names each union-find set by the `threadKey` most members derive (it used scan order, so threads flipped as bodies backfilled). `upsertMessage` now joins a new message to the thread of any stored message it mentions (`joinMentionedThread`), since Exmail chains have References gaps. The pipeline carries `draft.references`.
- **Extra UI helpers.** `appMode.ts` (palette commands run in the base mode, not `modal`), `threadTarget.ts` (triage keys in an open thread act on that thread, never the list cursor), `viewScope.ts` (undo restores rows only into the view it came from, else reloads; Done in Reminders dismisses the reminder), `folders.ts` (reload folders after creating Archive; `g e` on Gmail explains instead of doing nothing), `splitNav.ts`, `latest.ts` (`latestOnly`, so a slow stale list read never paints over a newer one).
- **Docs.** README also lists `⇧J` / `⇧K` / `⌘A` and `⌘⇧H`; CLAUDE.md gained keyboard rules (mode-scoped keys, shifted chords, picker-local keys) and the move-planning rule.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/core/store/migrate.ts` | modify | v18: message list headers, `outbox.remind_at`, `list_rows` + `list_dirty` + triggers, `reminders`, `mutes`, `vip_senders`, `replied_senders` (+trigger), `splits`, account-scoped `labels` |
| `src/core/store/migrate.test.ts` | modify | v18 backfills |
| `src/core/store/listRows.ts` | create | `refreshListRows`, `listView`, `countView`, `listInbox`, `repairListDrift`, `markDirtyByMessageId` |
| `src/core/store/listRows.test.ts` | create | property test against a fresh GROUP BY; ordering; drift repair |
| `src/core/store/repo.ts` | modify | upsert writes list headers; drop `listInbox`/`countInbox`; `threadMatesInFolder`, `setFolderRole` |
| `src/core/store/types.ts` | modify | `Message`/`UpsertMessageInput` list-header fields; `MessageListRow` reminder fields |
| `src/core/store/threadedList.test.ts` | modify | import `listInbox` from `listRows.js` |
| `src/core/store/search.ts` | modify | `parseQuery(input, ctx)` list context; `listWhere()` |
| `src/core/store/listQuery.test.ts` | create | the split-query parser |
| `src/core/store/splits.ts`, `splits.test.ts` | create | built-in and custom splits, per-split counts |
| `src/core/store/labels.ts`, `labels.test.ts` | create | Gmail label mapping and storage |
| `src/core/store/folderRoles.ts`, `folderRoles.test.ts` | modify | `doneRole(provider)` |
| `src/core/store/folderRepo.test.ts` | modify | `threadMatesInFolder`, `setFolderRole` |
| `src/core/pipeline/listHeaders.ts`, `listHeaders.test.ts` | create | List-Unsubscribe / bulk header parsing |
| `src/core/pipeline/types.ts`, `parse.ts`, `pipeline.ts` | modify | carry list headers and labels through the pipeline |
| `src/core/pipeline/parse.test.ts` | create | both passes write list headers; labels persist |
| `src/core/sync/imap.ts` | modify | `ENVELOPE_QUERY`, `envelopeToRaw`, `fetchLabels`, `storeFlag(..., useLabels)` |
| `src/core/sync/syncEngine.ts`, `reconcile.ts`, `flagWriter.ts` | modify | labels on backfill and reconcile; label writes |
| `src/core/triage/undoWindow.ts`, `.test.ts` | create | `undoWindowMs(settings)` |
| `src/core/triage/movePlan.ts`, `.test.ts` | create | thread-expanded, role-mapped move planning |
| `src/core/triage/reminders.ts`, `.test.ts` | create | reminder storage, wake logic |
| `src/core/triage/localRules.ts`, `.test.ts` | create | mute and VIP toggles |
| `src/core/triage/unsubscribe.ts`, `.test.ts` | create | List-Unsubscribe parsing, planning, running |
| `src/core/triage/zero.ts`, `.test.ts` | create | Get-me-to-zero candidates |
| `src/core/send/outbox.ts`, `flush.ts` | modify | `remind_at`; create the reminder after a send |
| `electron/ipc.ts` | modify | list IPC via `listView`; undo window; `holdMove`; export `flagWriterFor`; drift repair after sync |
| `electron/ipcTriage.ts` | create | splits, archive, reminders, mute, VIP, labels, unsubscribe, zero |
| `electron/reminderWorker.ts` | create | wakes due reminders every 30 s |
| `electron/main.ts` | modify | register triage IPC, start reminder worker |
| `electron/preload.ts` | modify | new API methods and types |
| `src/ui/commands.ts`, `commands.test.ts` | modify | mode-scoped and shifted ⌘ chords, `Shift+Tab`, `List` group, every new command |
| `src/ui/hooks/useHotkeys.ts`, `useCommandChord.ts` | modify | `eventKey()` (Shift+Tab); chord `shift` |
| `src/ui/store.ts` | modify | `UndoEntry`; split / chip / grouping state; `extendSelection` |
| `src/ui/chips.ts`, `listGroups.ts`, `when.ts`, `streak.ts` (+ tests) | create | pure UI helpers |
| `src/ui/views/TriageSettings.tsx` | create | undo window, Done folder, custom splits |
| `src/ui/views/SplitBar.tsx`, `RemindPicker.tsx`, `Picker.tsx`, `ConfirmDialog.tsx`, `ZeroModal.tsx`, `ZeroState.tsx` | create | triage UI |
| `src/ui/views/MessageList.tsx`, `Thread.tsx`, `ActionBar.tsx`, `Sidebar.tsx`, `Settings.tsx`, `Compose.tsx` | modify | grouping, Done buttons, Reminders view, remind-on-send |
| `src/ui/App.tsx`, `src/ui/styles/app.css` | modify | handlers and styles |
| `README.md`, `CLAUDE.md` | modify | docs |

---

### Task 0: Baseline

- [x] **Step 1: Check the baseline.** Run `pnpm typecheck && pnpm test`. Expect typecheck clean and **29 files / 204 tests** passing. If the counts differ, note the new numbers and carry on; later "expected" counts are only deltas.
- [x] **Step 2: Read the touch points once.** `src/core/store/repo.ts` (`upsertMessage`, `listInbox`), `src/core/store/migrate.ts` (v17 is the last entry), `electron/ipc.ts` (`messages:move`, `commitMove`, `pendingMoves`, `compose:queueSend`), `src/ui/commands.ts`, `src/ui/App.tsx` (`moveSelected`, `triageFromThread`, `handlers`).

---

### Task 1: Schema v18

Every table Phase 2 needs, in one migration, so later tasks only write code.

**Files:**
- Modify: `src/core/store/migrate.ts`
- Test: `src/core/store/migrate.test.ts`

- [x] **Step 1: Write the failing test.** Append to `src/core/store/migrate.test.ts`:

```ts
describe('migration v18 (triage)', () => {
  it('adds list headers, the read model and local triage tables, with backfills', () => {
    const db = new Database(join(mkdtempSync(join(tmpdir(), 'migrate-')), 't.db'))
    db.pragma('foreign_keys = ON')
    migrate(db, 17)
    db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
    db.prepare("INSERT INTO folders (id,account_id,name,path,role) VALUES (1,1,'INBOX','INBOX','inbox'),(2,1,'Sent','Sent','sent')").run()
    const ins = db.prepare(
      `INSERT INTO messages (account_id, folder_id, uid, message_id, thread_id, from_addr, to_addrs, cc_addrs, date, flags)
       VALUES (1, ?, ?, ?, ?, ?, ?, '[]', ?, '[]')`
    )
    ins.run(1, 1, '<a@x>', '<a@x>', 'friend@x.test', '[{"address":"me@x.test","name":null}]', 100)
    ins.run(2, 1, '<b@x>', '<a@x>', 'ME@x.test', '[{"address":"Friend@x.test","name":null}]', 200)
    ins.run(1, 2, '<c@x>', null, 'other@x.test', '[]', 300)

    expect(migrate(db)).toBeGreaterThanOrEqual(18)

    const cols = (t: string) =>
      (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('messages')).toEqual(
      expect.arrayContaining(['list_unsubscribe', 'unsubscribe_one_click', 'bulk'])
    )
    expect(cols('outbox')).toContain('remind_at')
    expect(cols('labels')).toContain('account_id')
    for (const t of ['list_rows', 'list_dirty', 'reminders', 'mutes', 'vip_senders', 'replied_senders', 'splits'])
      expect(cols(t).length).toBeGreaterThan(0)

    // Every synced thread starts dirty, so the first list read builds it.
    const dirty = db.prepare('SELECT thread_key FROM list_dirty ORDER BY thread_key').all()
    expect(dirty).toEqual([{ thread_key: '#3' }, { thread_key: '<a@x>' }])

    // Mail I sent marks its recipients as people I reply to (case-folded).
    expect(db.prepare('SELECT address FROM replied_senders').all()).toEqual([
      { address: 'friend@x.test' }
    ])

    // New writes keep list_dirty current.
    db.prepare('DELETE FROM list_dirty').run()
    db.prepare("UPDATE messages SET flags = '[\"\\\\Seen\"]' WHERE uid = 1 AND folder_id = 1").run()
    expect(db.prepare('SELECT thread_key FROM list_dirty').all()).toEqual([{ thread_key: '<a@x>' }])
    db.close()
  })
})
```

- [x] **Step 2: Run it and confirm it fails.** `pnpm exec vitest run src/core/store/migrate.test.ts`. Expected: FAIL (`expected 17 to be greater than or equal to 18` or missing columns).

- [x] **Step 3: Append v18** to the `migrations` array in `src/core/store/migrate.ts`, after the v17 entry:

```ts
  // v18: Phase 2 triage, in one migration so every later step finds its tables.
  // - List headers on messages: bulk detection for the Other split, and unsubscribe.
  // - outbox.remind_at: "remind me if no reply" chosen at send time.
  // - The list read model (list_rows), kept current by triggers that mark a
  //   thread dirty in list_dirty; refreshListRows() rebuilds only those.
  //   A message with no thread id is a thread of one, keyed '#<id>'.
  // - Local triage state: reminders and mutes (keyed by Message-ID so a
  //   rethread cannot orphan them), VIP senders, custom splits.
  // - replied_senders: everyone you have sent mail to, which Important reads.
  // - labels become account-scoped. The stage-1 tables were never written.
  (db) =>
    db.exec(`
ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT;
ALTER TABLE messages ADD COLUMN unsubscribe_one_click INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN bulk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN remind_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_messages_account_thread ON messages (account_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_account_msgid ON messages (account_id, message_id);

CREATE TABLE list_rows (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  thread_key TEXT NOT NULL,
  newest_id INTEGER NOT NULL,
  date INTEGER,
  sort_date INTEGER NOT NULL DEFAULT 0,
  msg_count INTEGER NOT NULL,
  unread_count INTEGER NOT NULL,
  flagged INTEGER NOT NULL DEFAULT 0,
  sender TEXT,
  bulk INTEGER NOT NULL DEFAULT 0,
  last_from_me INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  reminder_fired INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (folder_id, thread_key)
);
CREATE INDEX idx_list_rows_page ON list_rows (folder_id, hidden, sort_date DESC);
CREATE INDEX idx_list_rows_thread ON list_rows (account_id, thread_key);

CREATE TABLE list_dirty (
  account_id INTEGER NOT NULL,
  thread_key TEXT NOT NULL,
  PRIMARY KEY (account_id, thread_key)
) WITHOUT ROWID;

CREATE TRIGGER list_dirty_ai AFTER INSERT ON messages WHEN new.folder_id IS NOT NULL BEGIN
  INSERT OR IGNORE INTO list_dirty VALUES (new.account_id, COALESCE(new.thread_id, '#' || new.id));
END;
CREATE TRIGGER list_dirty_ad AFTER DELETE ON messages WHEN old.folder_id IS NOT NULL BEGIN
  INSERT OR IGNORE INTO list_dirty VALUES (old.account_id, COALESCE(old.thread_id, '#' || old.id));
END;
-- Only the columns list_rows reads. An envelope re-sync rewrites flags with the
-- same value, so compare old and new rather than firing on every UPDATE.
CREATE TRIGGER list_dirty_au AFTER UPDATE ON messages
  WHEN old.folder_id IS NOT new.folder_id OR old.thread_id IS NOT new.thread_id
    OR old.flags IS NOT new.flags OR old.date IS NOT new.date
    OR old.from_addr IS NOT new.from_addr OR old.bulk IS NOT new.bulk
BEGIN
  INSERT OR IGNORE INTO list_dirty
    SELECT old.account_id, COALESCE(old.thread_id, '#' || old.id) WHERE old.folder_id IS NOT NULL;
  INSERT OR IGNORE INTO list_dirty
    SELECT new.account_id, COALESCE(new.thread_id, '#' || new.id) WHERE new.folder_id IS NOT NULL;
END;

INSERT OR IGNORE INTO list_dirty (account_id, thread_key)
  SELECT account_id, COALESCE(thread_id, '#' || id) FROM messages WHERE folder_id IS NOT NULL;

CREATE TABLE reminders (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  subject TEXT,
  remind_at INTEGER NOT NULL,
  if_no_reply INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  fired_at INTEGER,
  UNIQUE (account_id, message_id)
);
CREATE INDEX idx_reminders_due ON reminders (remind_at) WHERE fired_at IS NULL;

CREATE TABLE mutes (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id)
) WITHOUT ROWID;

CREATE TABLE vip_senders (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  PRIMARY KEY (account_id, address)
) WITHOUT ROWID;

CREATE TABLE replied_senders (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  PRIMARY KEY (account_id, address)
) WITHOUT ROWID;

CREATE TRIGGER replied_senders_ai AFTER INSERT ON messages
  WHEN new.folder_id IS NOT NULL
   AND lower(COALESCE(new.from_addr, '')) = (SELECT lower(email) FROM accounts WHERE id = new.account_id)
BEGIN
  INSERT OR IGNORE INTO replied_senders (account_id, address)
    SELECT new.account_id, lower(json_extract(v.value, '$.address'))
      FROM json_each(CASE WHEN json_valid(new.to_addrs) THEN new.to_addrs ELSE '[]' END) v
     WHERE json_extract(v.value, '$.address') IS NOT NULL;
  INSERT OR IGNORE INTO replied_senders (account_id, address)
    SELECT new.account_id, lower(json_extract(v.value, '$.address'))
      FROM json_each(CASE WHEN json_valid(new.cc_addrs) THEN new.cc_addrs ELSE '[]' END) v
     WHERE json_extract(v.value, '$.address') IS NOT NULL;
END;

INSERT OR IGNORE INTO replied_senders (account_id, address)
  SELECT m.account_id, lower(json_extract(v.value, '$.address'))
    FROM messages m JOIN accounts a ON a.id = m.account_id,
         json_each(CASE WHEN json_valid(m.to_addrs) THEN m.to_addrs ELSE '[]' END) v
   WHERE m.folder_id IS NOT NULL AND lower(COALESCE(m.from_addr, '')) = lower(a.email)
     AND json_extract(v.value, '$.address') IS NOT NULL;
INSERT OR IGNORE INTO replied_senders (account_id, address)
  SELECT m.account_id, lower(json_extract(v.value, '$.address'))
    FROM messages m JOIN accounts a ON a.id = m.account_id,
         json_each(CASE WHEN json_valid(m.cc_addrs) THEN m.cc_addrs ELSE '[]' END) v
   WHERE m.folder_id IS NOT NULL AND lower(COALESCE(m.from_addr, '')) = lower(a.email)
     AND json_extract(v.value, '$.address') IS NOT NULL;

CREATE TABLE splits (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  sort_order REAL NOT NULL
);

DROP TABLE message_labels;
DROP TABLE labels;
CREATE TABLE labels (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  UNIQUE (account_id, name)
);
CREATE TABLE message_labels (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, label_id)
) WITHOUT ROWID;
CREATE INDEX idx_message_labels_label ON message_labels (label_id);
`)
```

- [x] **Step 4: Run the test, then the suite.** `pnpm exec vitest run src/core/store/migrate.test.ts` passes. Then `pnpm typecheck && pnpm test`: all green (the existing suites build fresh DBs at v18 and must not notice).

- [ ] **Step 5: Commit.**

```bash
git add src/core/store/migrate.ts src/core/store/migrate.test.ts
git commit -m "[feat] schema v18 for the list read model and local triage state"
```

---

### Task 2: The list read model

`list_rows` replaces the per-page GROUP BY in `listInbox`. Behaviour must not change except that the pager now counts conversations, not messages (it already showed threads).

**Files:**
- Create: `src/core/store/listRows.ts`, `src/core/store/listRows.test.ts`
- Modify: `src/core/store/repo.ts`, `src/core/store/types.ts`, `src/core/store/threadedList.test.ts`, `electron/ipc.ts`

- [x] **Step 1: Write the failing tests.**

```ts
// src/core/store/listRows.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import { countView, listView, refreshListRows, repairListDrift } from './listRows.js'
import { deleteMessageLocal, moveMessage, restoreMessage, setFlags, upsertMessage } from './repo.js'

const ACC = 1
const ME = 'me@x.test'
let inbox: number
let archive: number
let uid = 0

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'listrows-')), 't.db'))
  uid = 0
  const db = getDb()
  db.prepare('INSERT INTO accounts (id,email) VALUES (?,?)').run(ACC, ME)
  const ins = db.prepare('INSERT INTO folders (account_id,path,name,role) VALUES (?,?,?,?)')
  inbox = Number(ins.run(ACC, 'INBOX', 'INBOX', 'inbox').lastInsertRowid)
  archive = Number(ins.run(ACC, 'Archive', 'Archive', 'archive').lastInsertRowid)
})

function add(o: {
  folder?: number
  thread: string | null
  date: number
  seen?: boolean
  starred?: boolean
  from?: string
}): number {
  uid++
  const flags = [o.seen ? '\\Seen' : null, o.starred ? '\\Flagged' : null].filter(Boolean)
  return upsertMessage({
    account_id: ACC,
    folder_id: o.folder ?? inbox,
    uid,
    message_id: `<m${uid}@t>`,
    thread_id: o.thread,
    in_reply_to: null,
    from_addr: o.from ?? 'them@x.test',
    from_name: null,
    to_addrs: JSON.stringify([{ address: ME, name: null }]),
    cc_addrs: '[]',
    subject: `s${uid}`,
    date: o.date,
    snippet: null,
    flags: JSON.stringify(flags)
  })
}

interface Row {
  folder_id: number
  thread_key: string
  newest_id: number
  msg_count: number
  unread_count: number
  flagged: number
}

/** Computed in JS from the messages table, independent of the SQL rebuild. */
function oracle(): Row[] {
  const msgs = getDb()
    .prepare('SELECT id, folder_id, thread_id, date, flags FROM messages WHERE folder_id IS NOT NULL')
    .all() as { id: number; folder_id: number; thread_id: string | null; date: number | null; flags: string | null }[]
  const groups = new Map<string, typeof msgs>()
  for (const m of msgs) {
    const k = `${m.folder_id}|${m.thread_id ?? `#${m.id}`}`
    groups.set(k, [...(groups.get(k) ?? []), m])
  }
  const lower = (f: string | null) => (JSON.parse(f ?? '[]') as string[]).map((x) => x.toLowerCase())
  return [...groups.values()]
    .map((list) => {
      const newest = [...list].sort((a, b) => (b.date ?? 0) - (a.date ?? 0) || b.id - a.id)[0]
      return {
        folder_id: list[0].folder_id,
        thread_key: list[0].thread_id ?? `#${list[0].id}`,
        newest_id: newest.id,
        msg_count: list.length,
        unread_count: list.filter((m) => !lower(m.flags).includes('\\seen')).length,
        flagged: list.some((m) => lower(m.flags).includes('\\flagged')) ? 1 : 0
      }
    })
    .sort((a, b) => a.folder_id - b.folder_id || a.thread_key.localeCompare(b.thread_key))
}

function model(): Row[] {
  refreshListRows()
  return (
    getDb()
      .prepare('SELECT folder_id, thread_key, newest_id, msg_count, unread_count, flagged FROM list_rows')
      .all() as Row[]
  ).sort((a, b) => a.folder_id - b.folder_id || a.thread_key.localeCompare(b.thread_key))
}

/** mulberry32: a seeded PRNG so a failing seed reproduces. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('list read model', () => {
  it.each([1, 2, 3, 42, 1234])(
    'matches a fresh GROUP BY after random upserts, flags, moves, deletes and rethreads (seed %i)',
    (seed) => {
      const r = rng(seed)
      const pick = <T,>(xs: T[]): T | undefined => xs[Math.floor(r() * xs.length)]
      const live: number[] = []
      const moved = new Map<number, { folder: number; uid: number }>()
      for (let step = 0; step < 300; step++) {
        const op = r()
        if (op < 0.4 || !live.length) {
          live.push(
            add({
              folder: pick([inbox, archive]),
              thread: pick(['t1', 't2', 't3', 't4', null]) ?? null,
              date: Math.floor(r() * 1000),
              seen: r() < 0.5,
              starred: r() < 0.2
            })
          )
        } else if (op < 0.6) {
          setFlags(pick(live)!, JSON.stringify(r() < 0.5 ? ['\\Seen'] : []))
        } else if (op < 0.75) {
          const id = pick(live)!
          const m = getDb().prepare('SELECT folder_id, uid FROM messages WHERE id = ?').get(id) as
            | { folder_id: number; uid: number | null }
            | undefined
          if (m?.uid) {
            moved.set(id, { folder: m.folder_id, uid: m.uid })
            moveMessage(id, m.folder_id === inbox ? archive : inbox)
          }
        } else if (op < 0.82) {
          const entry = pick([...moved.entries()])
          if (entry) {
            restoreMessage(entry[0], entry[1].folder, entry[1].uid)
            moved.delete(entry[0])
          }
        } else if (op < 0.9) {
          const i = Math.floor(r() * live.length)
          deleteMessageLocal(live[i])
          moved.delete(live[i])
          live.splice(i, 1)
        } else {
          getDb()
            .prepare('UPDATE messages SET thread_id = ? WHERE id = ?')
            .run(pick(['t1', 't5', null]) ?? null, pick(live)!)
        }
        if (step % 7 === 0) expect(model()).toEqual(oracle())
      }
      expect(model()).toEqual(oracle())
    }
  )

  it('lists newest thread first with its counts, and counts conversations', () => {
    add({ thread: 'a', date: 100, seen: true })
    add({ thread: 'a', date: 300 })
    add({ thread: 'b', date: 200, seen: true })
    const rows = listView(inbox)
    expect(rows.map((x) => [x.subject, x.thread_count, x.thread_unread])).toEqual([
      ['s2', 2, 1],
      ['s3', 1, 0]
    ])
    expect(countView(inbox)).toBe(2)
  })

  it('knows when the last word in a thread is mine, across folders', () => {
    add({ thread: 'a', date: 100 })
    add({ folder: archive, thread: 'a', date: 200, from: 'ME@x.test' })
    refreshListRows()
    const row = getDb()
      .prepare('SELECT last_from_me FROM list_rows WHERE folder_id = ?')
      .get(inbox) as { last_from_me: number }
    expect(row.last_from_me).toBe(1)
  })

  it('repairs a folder whose counts drifted', () => {
    add({ thread: 'a', date: 100 })
    refreshListRows()
    getDb().prepare('UPDATE list_rows SET unread_count = 99').run()
    expect(repairListDrift(ACC)).toEqual([inbox])
    expect(listView(inbox)[0].thread_unread).toBe(1)
    expect(repairListDrift(ACC)).toEqual([])
  })
})
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/core/store/listRows.test.ts`. Expected: FAIL, cannot resolve `./listRows.js`.

- [x] **Step 3: Create `src/core/store/listRows.ts`.**

```ts
import { getDb } from './db.js'
import { LIST_COLS } from './repo.js'
import type { MessageListRow } from './types.js'

/**
 * The list read model: one row per (folder, thread). Triggers on `messages`
 * (migration v18) mark a thread dirty; this rebuilds just those threads, so a
 * list read is one indexed scan of list_rows instead of a GROUP BY per page.
 *
 * Thread state that spans folders (whether the last word is mine, mutes,
 * reminders) is computed over every synced folder of the account; counts and
 * the newest message are per folder.
 */
const REBUILD_SQL = `
WITH dm AS (
  SELECT m.id, m.account_id, d.thread_key, m.folder_id, m.date, m.flags,
         lower(COALESCE(m.from_addr, '')) AS from_l, m.bulk, m.message_id
    FROM list_dirty d
    JOIN messages m ON m.account_id = d.account_id AND m.thread_id = d.thread_key
   WHERE m.folder_id IS NOT NULL
  UNION ALL
  SELECT m.id, m.account_id, d.thread_key, m.folder_id, m.date, m.flags,
         lower(COALESCE(m.from_addr, '')), m.bulk, m.message_id
    FROM list_dirty d
    JOIN messages m ON m.id = CAST(substr(d.thread_key, 2) AS INTEGER)
   WHERE d.thread_key GLOB '#*' AND m.thread_id IS NULL
     AND m.folder_id IS NOT NULL AND m.account_id = d.account_id
),
ranked AS (
  SELECT dm.*, lower(a.email) AS me,
         ROW_NUMBER() OVER (PARTITION BY dm.account_id, dm.thread_key
                            ORDER BY COALESCE(dm.date, 0) DESC, dm.id DESC) AS t_rank,
         ROW_NUMBER() OVER (PARTITION BY dm.account_id, dm.folder_id, dm.thread_key
                            ORDER BY COALESCE(dm.date, 0) DESC, dm.id DESC) AS g_rank
    FROM dm JOIN accounts a ON a.id = dm.account_id
),
rem AS (
  SELECT r.account_id, ranked.thread_key, r.created_at, r.fired_at
    FROM ranked JOIN reminders r
      ON r.account_id = ranked.account_id AND r.message_id = ranked.message_id
),
t AS (
  SELECT account_id, thread_key,
         MAX(CASE WHEN t_rank = 1 THEN from_l = me END) AS last_from_me,
         MAX(CASE WHEN from_l <> me THEN COALESCE(date, 0) END) AS last_inbound,
         SUM(EXISTS (SELECT 1 FROM mutes x
                      WHERE x.account_id = ranked.account_id
                        AND x.message_id = ranked.message_id)) > 0 AS muted
    FROM ranked GROUP BY account_id, thread_key
),
g AS (
  SELECT account_id, folder_id, thread_key,
         MAX(CASE WHEN g_rank = 1 THEN id END) AS newest_id,
         MAX(date) AS date,
         MAX(CASE WHEN g_rank = 1 THEN from_l END) AS sender,
         MAX(CASE WHEN g_rank = 1 THEN COALESCE(bulk, 0) END) AS bulk,
         COUNT(*) AS msg_count,
         SUM(NOT EXISTS (SELECT 1 FROM json_each(COALESCE(flags, '[]'))
                          WHERE lower(json_each.value) = '\\seen')) AS unread_count,
         SUM(EXISTS (SELECT 1 FROM json_each(COALESCE(flags, '[]'))
                      WHERE lower(json_each.value) = '\\flagged')) > 0 AS flagged
    FROM ranked GROUP BY account_id, folder_id, thread_key
)
INSERT INTO list_rows (account_id, folder_id, thread_key, newest_id, date, sort_date,
                       msg_count, unread_count, flagged, sender, bulk, last_from_me,
                       hidden, reminder_fired)
SELECT g.account_id, g.folder_id, g.thread_key, g.newest_id, g.date,
       MAX(COALESCE(g.date, 0), COALESCE(
         (SELECT MAX(rem.fired_at) FROM rem
           WHERE rem.account_id = g.account_id AND rem.thread_key = g.thread_key), 0)),
       g.msg_count, g.unread_count, g.flagged, g.sender, COALESCE(g.bulk, 0),
       COALESCE(t.last_from_me, 0),
       -- Remind me and mute are local: they hide the Inbox row only, and any
       -- reply that arrives after the reminder was set brings the thread back.
       f.role IS 'inbox' AND (t.muted OR EXISTS (
         SELECT 1 FROM rem
          WHERE rem.account_id = g.account_id AND rem.thread_key = g.thread_key
            AND rem.fired_at IS NULL AND COALESCE(t.last_inbound, 0) <= rem.created_at)),
       EXISTS (SELECT 1 FROM rem
                WHERE rem.account_id = g.account_id AND rem.thread_key = g.thread_key
                  AND rem.fired_at IS NOT NULL)
  FROM g
  JOIN t ON t.account_id = g.account_id AND t.thread_key = g.thread_key
  JOIN folders f ON f.id = g.folder_id
`

/** Rebuilds every dirty thread. Returns how many were dirty; 0 costs one count. */
export function refreshListRows(): number {
  const db = getDb()
  const { c } = db.prepare('SELECT count(*) AS c FROM list_dirty').get() as { c: number }
  if (!c) return 0
  db.transaction(() => {
    db.prepare(
      `DELETE FROM list_rows WHERE EXISTS (
         SELECT 1 FROM list_dirty d
          WHERE d.account_id = list_rows.account_id AND d.thread_key = list_rows.thread_key)`
    ).run()
    db.prepare(REBUILD_SQL).run()
    db.prepare('DELETE FROM list_dirty').run()
  })()
  return c
}

/** Marks the thread(s) holding a Message-ID dirty: reminders and mutes call this. */
export function markDirtyByMessageId(accountId: number, messageId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO list_dirty (account_id, thread_key)
       SELECT account_id, COALESCE(thread_id, '#' || id) FROM messages
        WHERE account_id = ? AND message_id = ? AND folder_id IS NOT NULL`
    )
    .run(accountId, messageId)
}

export interface ListViewOptions {
  limit?: number
  offset?: number
}

const M_COLS = LIST_COLS.split(', ')
  .map((c) => `m.${c}`)
  .join(', ')

/** One page of a folder, newest conversation first. Hidden rows (reminders, mutes) are left out. */
export function listView(folderId: number, opts: ListViewOptions = {}): MessageListRow[] {
  refreshListRows()
  return getDb()
    .prepare(
      `SELECT ${M_COLS}, lr.msg_count AS thread_count, lr.unread_count AS thread_unread,
              lr.reminder_fired AS reminder_fired
         FROM list_rows lr JOIN messages m ON m.id = lr.newest_id
        WHERE lr.folder_id = ? AND lr.hidden = 0
        ORDER BY lr.sort_date DESC, lr.newest_id DESC
        LIMIT ? OFFSET ?`
    )
    .all(folderId, opts.limit ?? 100, opts.offset ?? 0) as MessageListRow[]
}

/** Conversations behind a view, for the pager. Mirrors listView's WHERE. */
export function countView(folderId: number): number {
  refreshListRows()
  return (
    getDb()
      .prepare('SELECT count(*) AS c FROM list_rows lr WHERE lr.folder_id = ? AND lr.hidden = 0')
      .get(folderId) as { c: number }
  ).c
}

/** Kept for callers and tests that predate views. */
export function listInbox(folderId: number, limit = 100, offset = 0): MessageListRow[] {
  return listView(folderId, { limit, offset })
}

/**
 * Compares each folder's thread and unread totals with a fresh GROUP BY and
 * rebuilds any folder that disagrees. Returns the folders it repaired. Cheap:
 * two aggregates per account, run after each sync.
 */
export function repairListDrift(accountId: number): number[] {
  refreshListRows()
  const db = getDb()
  const fresh = db
    .prepare(
      `SELECT folder_id, COUNT(DISTINCT COALESCE(thread_id, '#' || id)) AS threads,
              SUM(NOT EXISTS (SELECT 1 FROM json_each(COALESCE(m.flags, '[]'))
                               WHERE lower(json_each.value) = '\\seen')) AS unread
         FROM messages m WHERE account_id = ? AND folder_id IS NOT NULL
        GROUP BY folder_id`
    )
    .all(accountId) as { folder_id: number; threads: number; unread: number }[]
  const model = db
    .prepare(
      `SELECT folder_id, COUNT(*) AS threads, SUM(unread_count) AS unread
         FROM list_rows WHERE account_id = ? GROUP BY folder_id`
    )
    .all(accountId) as { folder_id: number; threads: number; unread: number }[]

  const key = (r: { threads: number; unread: number }) => `${r.threads}/${r.unread}`
  const want = new Map(fresh.map((r) => [r.folder_id, key(r)]))
  const have = new Map(model.map((r) => [r.folder_id, key(r)]))
  const drifted = [...new Set([...want.keys(), ...have.keys()])].filter(
    (f) => want.get(f) !== have.get(f)
  )
  if (!drifted.length) return []

  db.transaction(() => {
    for (const folderId of drifted) {
      db.prepare('DELETE FROM list_rows WHERE folder_id = ?').run(folderId)
      db.prepare(
        `INSERT OR IGNORE INTO list_dirty (account_id, thread_key)
         SELECT account_id, COALESCE(thread_id, '#' || id) FROM messages WHERE folder_id = ?`
      ).run(folderId)
    }
  })()
  refreshListRows()
  return drifted.sort((a, b) => a - b)
}
```

- [x] **Step 4: Add the reminder field to `MessageListRow`** in `src/core/store/types.ts`, inside the `& { ... }` block after `thread_unread?: number`:

```ts
  /** 1 when a reminder on this thread has fired (list_rows.reminder_fired). */
  reminder_fired?: number
  /** Set only in the Reminders view: when the reminder is due. */
  remind_at?: number
```

- [x] **Step 5: Remove the old list reads from `src/core/store/repo.ts`.** Delete the whole `listInbox` function with its doc comment, and the whole `countInbox` function with its doc comment. Nothing else in `repo.ts` changes.

- [x] **Step 6: Point the old test at the new module.** In `src/core/store/threadedList.test.ts` change the import line to:

```ts
import { upsertMessage } from './repo.js'
import { listInbox } from './listRows.js'
```

- [x] **Step 7: Wire main.** In `electron/ipc.ts`:
  - Remove `countInbox` and `listInbox` from the `../src/core/store/repo.js` import list.
  - Add `import { countView, listView, repairListDrift } from '../src/core/store/listRows.js'`.
  - Replace the `messages:list` handler with:

```ts
  ipcMain.handle('messages:list', (_e, folderId: number, limit = 100, offset = 0) =>
    listView(folderId, { limit, offset })
  )
```

  - In `messages:count`, replace `: countInbox(folderId)` with `: countView(folderId)`.
  - In `runSyncFor`, directly after `const result = await syncAccount(...)` resolves (before `resumePendingMoves`), add:

```ts
    // The read model is trigger-maintained; this catches anything that slipped
    // past the triggers (a crash mid-rebuild, a manual DB edit).
    const drifted = repairListDrift(s.accountId)
    if (drifted.length) console.warn(`[listRows] repaired drift in folders ${drifted.join(', ')}`)
```

- [x] **Step 8: Run the tests.** `pnpm exec vitest run src/core/store/listRows.test.ts src/core/store/threadedList.test.ts` passes. Then `pnpm typecheck && pnpm test`: green, with 1 more file.

- [ ] **Step 9: Commit.**

```bash
git add src/core/store/listRows.ts src/core/store/listRows.test.ts src/core/store/repo.ts src/core/store/types.ts src/core/store/threadedList.test.ts electron/ipc.ts
git commit -m "[feat] list read model: list_rows rebuilt from dirty threads"
```

---

### Task 3: Capture list headers and Gmail labels

The Other split and Unsubscribe need `List-Unsubscribe` / bulk headers; labels need `X-GM-LABELS`. Both come in on the existing fetches.

**Files:**
- Create: `src/core/pipeline/listHeaders.ts`, `src/core/pipeline/listHeaders.test.ts`, `src/core/store/labels.ts`, `src/core/store/labels.test.ts`, `src/core/pipeline/parse.test.ts`
- Modify: `src/core/pipeline/types.ts`, `src/core/pipeline/parse.ts`, `src/core/pipeline/pipeline.ts`, `src/core/store/types.ts`, `src/core/store/repo.ts`, `src/core/sync/imap.ts`, `src/core/sync/syncEngine.ts`, `src/core/sync/reconcile.ts`, `src/core/sync/flagWriter.ts`

- [x] **Step 1: Write the failing tests.**

```ts
// src/core/pipeline/listHeaders.test.ts
import { describe, expect, it } from 'vitest'
import { headerValue, listHeadersFrom } from './listHeaders.js'

describe('listHeadersFrom', () => {
  it('reads a folded List-Unsubscribe and the one-click marker', () => {
    const raw =
      'Subject: hi\r\nList-Unsubscribe: <mailto:u@list.test?subject=stop>,\r\n <https://list.test/u/1>\r\n' +
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n'
    expect(listHeadersFrom(raw)).toEqual({
      unsubscribe: '<mailto:u@list.test?subject=stop>, <https://list.test/u/1>',
      oneClick: true,
      bulk: true
    })
  })

  it('treats List-Id, Precedence and Auto-Submitted as bulk', () => {
    expect(listHeadersFrom('List-Id: <dev.list.test>').bulk).toBe(true)
    expect(listHeadersFrom('Precedence: bulk').bulk).toBe(true)
    expect(listHeadersFrom('Auto-Submitted: auto-generated').bulk).toBe(true)
    expect(listHeadersFrom('Auto-Submitted: no').bulk).toBe(false)
  })

  it('finds nothing on a personal message', () => {
    expect(listHeadersFrom('From: a@b.test\r\nSubject: lunch?\r\n')).toEqual({
      unsubscribe: null,
      oneClick: false,
      bulk: false
    })
  })

  it('matches header names case-insensitively, and only whole names', () => {
    expect(headerValue('x-list-id: nope\r\nLIST-ID: yes', 'list-id')).toBe('yes')
  })
})
```

```ts
// src/core/store/labels.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import {
  addMessageLabel,
  gmailLabelChoices,
  labelsForMessages,
  messageLabels,
  removeMessageLabel,
  setMessageLabels,
  userLabels
} from './labels.js'

let msg: number

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'labels-')), 't.db'))
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@gmail.com')").run()
  db.prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox')").run()
  msg = Number(
    db.prepare("INSERT INTO messages (account_id,folder_id,uid,message_id) VALUES (1,1,1,'<a@x>')").run()
      .lastInsertRowid
  )
})

describe('Gmail label mapping', () => {
  it('drops system labels, which are folders or flags here', () => {
    expect(userLabels(['\\Inbox', '\\Important', 'Work', 'Clients/Acme', 'Work'])).toEqual([
      'Work',
      'Clients/Acme'
    ])
  })

  it('offers user-label folders, not system ones', () => {
    expect(
      gmailLabelChoices([
        { path: 'INBOX', role: 'inbox' },
        { path: '[Gmail]/All Mail', role: 'all' },
        { path: '[Gmail]/Starred', role: null },
        { path: 'Work', role: null },
        { path: 'Clients/Acme', role: null }
      ])
    ).toEqual(['Clients/Acme', 'Work'])
  })

  it('replaces a message’s labels and reports whether anything changed', () => {
    expect(setMessageLabels(msg, 1, ['Work', '\\Inbox'])).toBe(true)
    expect(setMessageLabels(msg, 1, ['Work'])).toBe(false)
    expect(messageLabels(msg)).toEqual(['Work'])
    expect(setMessageLabels(msg, 1, [])).toBe(true)
    expect(messageLabels(msg)).toEqual([])
  })

  it('adds and removes one label', () => {
    expect(addMessageLabel(msg, 1, 'Work')).toBe(true)
    expect(addMessageLabel(msg, 1, 'Work')).toBe(false)
    expect(labelsForMessages([msg])).toEqual({ [msg]: ['Work'] })
    expect(removeMessageLabel(msg, 1, 'Work')).toBe(true)
    expect(labelsForMessages([msg])).toEqual({ [msg]: [] })
  })
})
```

```ts
// src/core/pipeline/parse.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { getMessage } from '../store/repo.js'
import { messageLabels } from '../store/labels.js'
import { parseProcessor } from './parse.js'
import { runPipeline } from './pipeline.js'

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'parse-')), 't.db'))
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (1,'me@gmail.com')").run()
  getDb().prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox')").run()
})

describe('list headers and labels through the pipeline', () => {
  it('writes them on the envelope pass', async () => {
    const r = await runPipeline(
      {
        accountId: 1,
        folderId: 1,
        uid: 7,
        envelope: { messageId: '<n@list.test>', subject: 'News', date: new Date(1000) },
        flags: [],
        listHeaders: { unsubscribe: '<https://list.test/u>', oneClick: true, bulk: true },
        labels: ['\\Inbox', 'Newsletters']
      },
      [parseProcessor]
    )
    const m = getMessage(r.id!)!
    expect([m.list_unsubscribe, m.unsubscribe_one_click, m.bulk]).toEqual(['<https://list.test/u>', 1, 1])
    expect(messageLabels(r.id!)).toEqual(['Newsletters'])
  })

  it('writes them on the body pass from the raw headers', async () => {
    const source =
      'From: news@list.test\r\nTo: me@gmail.com\r\nSubject: News\r\nMessage-ID: <b@list.test>\r\n' +
      'List-Unsubscribe: <mailto:u@list.test>\r\nContent-Type: text/plain\r\n\r\nhello\r\n'
    const r = await runPipeline({ accountId: 1, folderId: 1, uid: 8, source }, [parseProcessor])
    const m = getMessage(r.id!)!
    expect([m.list_unsubscribe, m.unsubscribe_one_click, m.bulk]).toEqual(['<mailto:u@list.test>', 0, 1])
  })
})
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/core/pipeline/listHeaders.test.ts src/core/store/labels.test.ts src/core/pipeline/parse.test.ts`. Expected: FAIL on missing modules / properties.

- [x] **Step 3: Create `src/core/pipeline/listHeaders.ts`.**

```ts
/** What the list headers of one message say. */
export interface ListHeaders {
  /** Raw List-Unsubscribe value, e.g. `<mailto:…>, <https://…>`. */
  unsubscribe: string | null
  /** RFC 8058: List-Unsubscribe-Post says a POST unsubscribes without a page. */
  oneClick: boolean
  /** Mailing list, newsletter or machine-sent: feeds the Other split. */
  bulk: boolean
}

/** One header's value from raw header text, unfolded. Case-insensitive; null when absent. */
export function headerValue(raw: string, name: string): string | null {
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ')
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(unfolded)
  return m ? m[1].trim() : null
}

export function listHeadersFrom(raw: string): ListHeaders {
  const unsubscribe = headerValue(raw, 'list-unsubscribe') || null
  const post = headerValue(raw, 'list-unsubscribe-post') ?? ''
  const precedence = (headerValue(raw, 'precedence') ?? '').toLowerCase()
  const autoSubmitted = (headerValue(raw, 'auto-submitted') ?? '').toLowerCase()
  return {
    unsubscribe,
    oneClick: /list-unsubscribe=one-click/i.test(post),
    bulk:
      unsubscribe !== null ||
      headerValue(raw, 'list-id') !== null ||
      /^(bulk|list|junk)$/.test(precedence) ||
      (autoSubmitted !== '' && autoSubmitted !== 'no')
  }
}
```

- [x] **Step 4: Create `src/core/store/labels.ts`.**

```ts
import { getDb } from './db.js'
import type { Folder } from './types.js'

/** Gmail system labels (\Inbox, \Important, \Starred…) are folders or flags here, never labels. */
export function userLabels(labels: string[]): string[] {
  return [...new Set(labels.filter((l) => l && !l.startsWith('\\')))]
}

/**
 * Labels a Gmail account can apply: its user-label folders. Phase 1 stores
 * every Gmail folder but syncs only system ones, so these rows exist and stay
 * empty; their paths are exactly the X-GM-LABELS names.
 */
export function gmailLabelChoices(folders: Pick<Folder, 'path' | 'role'>[]): string[] {
  return folders
    .filter(
      (f) =>
        f.role === null &&
        f.path.toUpperCase() !== 'INBOX' &&
        !f.path.startsWith('[Gmail]') &&
        !f.path.startsWith('[Google Mail]')
    )
    .map((f) => f.path)
    .sort((a, b) => a.localeCompare(b))
}

function labelId(accountId: number, name: string): number {
  const db = getDb()
  db.prepare('INSERT OR IGNORE INTO labels (account_id, name) VALUES (?, ?)').run(accountId, name)
  return (
    db.prepare('SELECT id FROM labels WHERE account_id = ? AND name = ?').get(accountId, name) as {
      id: number
    }
  ).id
}

export function messageLabels(messageId: number): string[] {
  return (
    getDb()
      .prepare(
        `SELECT l.name FROM message_labels ml JOIN labels l ON l.id = ml.label_id
          WHERE ml.message_id = ? ORDER BY l.name`
      )
      .all(messageId) as { name: string }[]
  ).map((r) => r.name)
}

/** Replaces a message's labels with `names` (system labels dropped). True when anything changed. */
export function setMessageLabels(messageId: number, accountId: number, names: string[]): boolean {
  const want = new Set(userLabels(names))
  const have = new Set(messageLabels(messageId))
  if (want.size === have.size && [...want].every((n) => have.has(n))) return false
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM message_labels WHERE message_id = ?').run(messageId)
    const ins = db.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)')
    for (const n of want) ins.run(messageId, labelId(accountId, n))
  })()
  return true
}

export function addMessageLabel(messageId: number, accountId: number, name: string): boolean {
  return (
    getDb()
      .prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)')
      .run(messageId, labelId(accountId, name)).changes > 0
  )
}

export function removeMessageLabel(messageId: number, accountId: number, name: string): boolean {
  return (
    getDb()
      .prepare(
        `DELETE FROM message_labels WHERE message_id = ?
           AND label_id = (SELECT id FROM labels WHERE account_id = ? AND name = ?)`
      )
      .run(messageId, accountId, name).changes > 0
  )
}

export function labelsForMessages(ids: number[]): Record<number, string[]> {
  return Object.fromEntries(ids.map((id) => [id, messageLabels(id)]))
}
```

- [x] **Step 5: Carry the data through the pipeline.**
  - `src/core/pipeline/types.ts`: add `import type { ListHeaders } from './listHeaders.js'` and, inside `RawMessage` after `flags?: string[]`:

```ts
  /** List-Unsubscribe / bulk headers from the envelope fetch. Absent on body passes. */
  listHeaders?: ListHeaders
  /** Gmail X-GM-LABELS as fetched. Absent means "no authority": stored labels stay. */
  labels?: string[]
```

  - `src/core/store/types.ts`: add to `Message` after `workflow_state`:

```ts
  list_unsubscribe: string | null
  unsubscribe_one_click: number
  bulk: number
```

    and to `UpsertMessageInput` after `entities?`:

```ts
  list_unsubscribe?: string | null
  unsubscribe_one_click?: number
  bulk?: number
```

  - `src/core/store/repo.ts` `upsertMessage`: add `list_unsubscribe: null, unsubscribe_one_click: 0, bulk: 0,` to the `row` defaults (before `...m`); add `list_unsubscribe, unsubscribe_one_click, bulk` to the INSERT column list and `@list_unsubscribe, @unsubscribe_one_click, @bulk` to VALUES; add to the `DO UPDATE SET` list:

```sql
         list_unsubscribe = COALESCE(excluded.list_unsubscribe, messages.list_unsubscribe),
         unsubscribe_one_click = MAX(excluded.unsubscribe_one_click, messages.unsubscribe_one_click),
         bulk = MAX(excluded.bulk, messages.bulk),
```

  - `src/core/pipeline/parse.ts`: `import { listHeadersFrom } from './listHeaders.js'`. In the source branch, after `draft.body_fetched = 1`:

```ts
      const lh = listHeadersFrom(p.headerLines.map((h) => h.line).join('\r\n'))
      draft.list_unsubscribe = lh.unsubscribe
      draft.unsubscribe_one_click = lh.oneClick ? 1 : 0
      draft.bulk = lh.bulk ? 1 : 0
```

    In the envelope branch, after `draft.body_fetched = 0`:

```ts
    if (raw.listHeaders) {
      draft.list_unsubscribe = raw.listHeaders.unsubscribe
      draft.unsubscribe_one_click = raw.listHeaders.oneClick ? 1 : 0
      draft.bulk = raw.listHeaders.bulk ? 1 : 0
    }
```

  - `src/core/pipeline/pipeline.ts`: `import { setMessageLabels } from '../store/labels.js'`. Inside the transaction, right after `const msgId = upsertMessage(ctx.draft)`:

```ts
    if (raw.labels) setMessageLabels(msgId, raw.accountId, raw.labels)
```

- [x] **Step 6: Fetch the headers and labels in `src/core/sync/imap.ts`.**
  - Change the import to `import { ImapFlow, type FetchMessageObject, type FetchQueryObject, type ListResponse } from 'imapflow'` and add `import { listHeadersFrom } from '../pipeline/listHeaders.js'`.
  - Add, above `fetchEnvelopes`:

```ts
/** Header lines pulled with every envelope: threading plus list detection. */
export const ENVELOPE_HEADERS = [
  'references',
  'list-unsubscribe',
  'list-unsubscribe-post',
  'list-id',
  'precedence',
  'auto-submitted'
]

/** imapflow only sends X-GM-LABELS when the server has X-GM-EXT-1, so this is safe everywhere. */
export const ENVELOPE_QUERY: FetchQueryObject = {
  uid: true,
  envelope: true,
  flags: true,
  labels: true,
  headers: [...ENVELOPE_HEADERS]
}

/** One fetched envelope as pipeline input. Shared by sync and backfill so they cannot drift. */
export function envelopeToRaw(msg: FetchMessageObject, accountId: number, folderId: number): RawMessage {
  return {
    accountId,
    folderId,
    uid: msg.uid,
    envelope: {
      messageId: msg.envelope?.messageId ? ensureMessageIdFormat(msg.envelope.messageId) : null,
      inReplyTo: msg.envelope?.inReplyTo ? ensureMessageIdFormat(msg.envelope.inReplyTo) : null,
      references: parseReferences(msg.headers),
      from: msg.envelope?.from?.[0]
        ? { address: msg.envelope.from[0].address, name: msg.envelope.from[0].name }
        : null,
      to: msg.envelope?.to?.map((a) => ({ address: a.address, name: a.name })) ?? [],
      cc: msg.envelope?.cc?.map((a) => ({ address: a.address, name: a.name })) ?? [],
      subject: msg.envelope?.subject ?? null,
      date: msg.envelope?.date ?? null
    },
    flags: msg.flags ? [...msg.flags] : [],
    listHeaders: msg.headers ? listHeadersFrom(msg.headers.toString('utf8')) : undefined,
    labels: msg.labels ? [...msg.labels] : undefined
  }
}
```

  - In `fetchEnvelopes`, replace the fetch query object with `ENVELOPE_QUERY` and replace the whole `messages.push({ ... })` with `messages.push(envelopeToRaw(msg, opts.accountId, opts.folderId))`.
  - Add after `fetchFlags`:

```ts
/** UID -> Gmail labels for a mailbox. Empty on servers without X-GM-EXT-1. */
export async function fetchLabels(client: ImapFlow, path: string): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>()
  const lock = await client.getMailboxLock(path)
  try {
    const mb = client.mailbox
    if (!mb || typeof mb === 'boolean' || mb.exists === 0) return out
    for await (const msg of client.fetch('1:*', { uid: true, labels: true }, { uid: true })) {
      if (msg.labels) out.set(msg.uid, [...msg.labels])
    }
  } finally {
    lock.release()
  }
  return out
}
```

  - Give `storeFlag` a last parameter `useLabels = false` and pass `{ uid: true, useLabels }` to both `messageFlagsAdd` and `messageFlagsRemove`. Update its doc comment: "Add or remove one IMAP flag, or with `useLabels` one Gmail label, on a message by UID."

- [x] **Step 7: Use them in sync.**
  - `src/core/sync/syncEngine.ts` `backfillFolder`: import `ENVELOPE_QUERY, envelopeToRaw` from `./imap.js` (drop the now-unused `ensureMessageIdFormat`, `parseReferences` imports if nothing else uses them). Replace the fetch query with `ENVELOPE_QUERY` and the `raw.push({ ... })` body with `raw.push(envelopeToRaw(msg, accountId, folder.id))`.
  - `syncEngine.ts` `syncAccount`: in the `reconcileFolder(...)` call add `labelsAccountId: config.provider === 'gmail' ? accountId : undefined` to the options object.
  - `src/core/sync/reconcile.ts`: import `fetchLabels` from `./imap.js` and `setMessageLabels` from `../store/labels.js`; add `labelsAccountId?: number` to the `opts` type; after the flags loop, before `return`:

```ts
  // Gmail labels change in the web UI without touching flags or UIDNEXT.
  if (opts.labelsAccountId !== undefined) {
    const labels = await fetchLabels(client, path)
    for (const row of local) {
      const l = labels.get(row.uid)
      if (!l || skip.has(row.id)) continue
      if (setMessageLabels(row.id, opts.labelsAccountId, l)) updated++
    }
  }
```

  - `src/core/sync/flagWriter.ts`: add `useLabels?: boolean` to `Job` (doc: "Write a Gmail label (X-GM-LABELS) instead of a flag."), and call `storeFlag(client, loc.path, loc.uid, job.flag, job.add, job.useLabels ?? false)`.

- [x] **Step 8: Run the tests.** The three new files pass. `pnpm typecheck && pnpm test`: green, 3 more files.

- [ ] **Step 9: Commit.**

```bash
git add src/core/pipeline src/core/store/labels.ts src/core/store/labels.test.ts src/core/store/types.ts src/core/store/repo.ts src/core/sync/imap.ts src/core/sync/syncEngine.ts src/core/sync/reconcile.ts src/core/sync/flagWriter.ts
git commit -m "[feat] store list-unsubscribe, bulk headers and gmail labels"
```

---

### Task 4: List views as queries — splits and chip operators

**Files:**
- Create: `src/core/store/listQuery.test.ts`, `src/core/store/splits.ts`, `src/core/store/splits.test.ts`, `electron/ipcTriage.ts`
- Modify: `src/core/store/search.ts`, `src/core/store/listRows.ts`, `electron/ipc.ts`, `electron/main.ts`, `electron/preload.ts`

- [x] **Step 1: Write the failing tests.**

```ts
// src/core/store/listQuery.test.ts
import { describe, expect, it } from 'vitest'
import { listWhere, parseQuery } from './search.js'

describe('the split-query parser (list context)', () => {
  it('reads is:unread as the thread, not the newest message', () => {
    expect(parseQuery('is:unread', 'list').predicates).toEqual([
      { sql: 'lr.unread_count > 0', params: [] }
    ])
  })

  it('leaves search-context is:unread on message flags', () => {
    expect(parseQuery('is:unread').predicates[0].sql).toContain('json_each')
  })

  it('knows the thread-state operators only in a list', () => {
    for (const op of ['needs-reply', 'waiting', 'important', 'other', 'vip', 'bulk'])
      expect(parseQuery(`is:${op}`, 'list').predicates).toHaveLength(1)
    expect(parseQuery('is:needs-reply').terms).toEqual(['is:needs-reply'])
  })

  it('makes Other exactly the complement of Important', () => {
    const imp = parseQuery('is:important', 'list').predicates[0].sql
    expect(parseQuery('is:other', 'list').predicates[0].sql).toBe(`NOT ${imp}`)
  })

  it('ANDs a split and a chip, and keeps field operators on the newest message', () => {
    const w = listWhere('is:important is:unread from:bob')
    expect(w.sql.startsWith(' AND ')).toBe(true)
    expect(w.sql).toContain('lr.unread_count > 0')
    expect(w.sql).toContain('m.from_addr')
    expect(w.params).toEqual(['%bob%'])
  })

  it('sends bare words to the FTS index', () => {
    expect(listWhere('invoice')).toEqual({
      sql: ' AND m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)',
      params: ['"invoice"*']
    })
  })

  it('adds nothing for an empty query', () => {
    expect(listWhere('  ')).toEqual({ sql: '', params: [] })
  })
})
```

```ts
// src/core/store/splits.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import { countView, listView } from './listRows.js'
import { upsertMessage } from './repo.js'
import { deleteSplit, listSplits, saveSplit, splitCounts } from './splits.js'

const ME = 'me@x.test'
let uid = 0

function add(folder: number, o: { thread: string; from: string; to?: string; date: number; bulk?: boolean; seen?: boolean }) {
  uid++
  upsertMessage({
    account_id: 1,
    folder_id: folder,
    uid,
    message_id: `<m${uid}@t>`,
    thread_id: o.thread,
    in_reply_to: null,
    from_addr: o.from,
    from_name: null,
    to_addrs: JSON.stringify([{ address: o.to ?? ME, name: null }]),
    cc_addrs: '[]',
    subject: o.thread,
    date: o.date,
    snippet: null,
    flags: o.seen ? '["\\\\Seen"]' : '[]',
    bulk: o.bulk ? 1 : 0
  })
}

const subjects = (query: string) => listView(1, { query }).map((r) => r.subject)

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'splits-')), 't.db'))
  uid = 0
  const db = getDb()
  db.prepare('INSERT INTO accounts (id,email) VALUES (1,?)').run(ME)
  db.prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox'),(2,1,'Sent','sent')").run()
  add(2, { thread: 'friend', from: ME, to: 'friend@x.test', date: 50 }) // I once wrote to friend
  add(1, { thread: 'friend', from: 'friend@x.test', date: 100 })
  add(1, { thread: 'news', from: 'news@list.test', date: 200, bulk: true, seen: true })
  add(1, { thread: 'stranger', from: 'new@x.test', date: 300 })
  add(1, { thread: 'mine', from: 'boss@x.test', date: 10, seen: true })
  add(2, { thread: 'mine', from: ME, to: 'boss@x.test', date: 400 })
})

describe('split views', () => {
  it('puts people I reply to in Important and everything else in Other', () => {
    // Newest first by the Inbox copy's date: friend 100, mine 10.
    expect(subjects('is:important')).toEqual(['friend', 'mine'])
    expect(subjects('is:other')).toEqual(['stranger', 'news'])
  })

  it('promotes a VIP sender into Important', () => {
    getDb().prepare("INSERT INTO vip_senders (account_id,address) VALUES (1,'new@x.test')").run()
    expect(subjects('is:vip')).toEqual(['stranger'])
    expect(subjects('is:important')).toEqual(['stranger', 'friend', 'mine'])
  })

  it('filters needs-reply, waiting and unread on thread state', () => {
    expect(subjects('is:needs-reply')).toEqual(['stranger', 'friend'])
    expect(subjects('is:waiting')).toEqual(['mine'])
    expect(subjects('is:unread')).toEqual(['stranger', 'friend'])
    expect(countView(1, { query: 'is:important is:unread' })).toBe(1)
  })

  it('stores custom splits after the built-ins and counts each one', () => {
    const s = saveSplit({ name: 'Bosses', query: 'from:boss' })
    expect(listSplits().map((x) => x.id)).toEqual(['all', 'important', 'other', 'vip', s.id])
    expect(splitCounts(1)).toEqual({ all: 4, important: 2, other: 2, vip: 0, [s.id]: 1 })
    expect(splitCounts(1, 'is:unread')).toMatchObject({ all: 2, important: 1 })
    saveSplit({ id: s.id, name: 'Boss', query: 'from:boss' })
    expect(listSplits().at(-1)?.name).toBe('Boss')
    deleteSplit(s.id)
    expect(listSplits()).toHaveLength(4)
    expect(() => saveSplit({ name: ' ', query: 'x' })).toThrow()
  })
})
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/core/store/listQuery.test.ts src/core/store/splits.test.ts`. Expected: FAIL (no `listWhere`, no `splits.js`).

- [x] **Step 3: List context in `src/core/store/search.ts`.** Add above `parseQuery`:

```ts
/** `search` reads one message; `list` reads a list_rows row (alias lr) joined to its newest message (m). */
export type QueryContext = 'search' | 'list'

const VIP_SQL =
  'EXISTS (SELECT 1 FROM vip_senders v WHERE v.account_id = lr.account_id AND v.address = lr.sender)'
const REPLIED_SQL =
  'EXISTS (SELECT 1 FROM replied_senders rs WHERE rs.account_id = lr.account_id AND rs.address = lr.sender)'
/** VIPs, plus non-bulk mail from people you have written to. Other is its exact complement. */
const IMPORTANT_SQL = `(${VIP_SQL} OR (lr.bulk = 0 AND ${REPLIED_SQL}))`

/** `is:` values that read thread state from list_rows. List context only. */
const LIST_IS: Record<string, string> = {
  unread: 'lr.unread_count > 0',
  read: 'lr.unread_count = 0',
  starred: 'lr.flagged = 1',
  flagged: 'lr.flagged = 1',
  'needs-reply': 'lr.last_from_me = 0 AND lr.bulk = 0',
  waiting: 'lr.last_from_me = 1',
  bulk: 'lr.bulk = 1',
  vip: VIP_SQL,
  important: IMPORTANT_SQL,
  other: `NOT ${IMPORTANT_SQL}`
}
```

  Change the signature to `export function parseQuery(input: string, ctx: QueryContext = 'search'): Parsed` and make the `is` branch start like this (the existing `unread/read` and `starred/flagged` handling stays below it):

```ts
    if (field === 'is') {
      const v = value.toLowerCase()
      if (ctx === 'list' && LIST_IS[v]) {
        predicates.push({ sql: LIST_IS[v], params: [] })
        continue
      }
```

  Add at the end of the file:

```ts
/**
 * Extra WHERE for a list view: predicates from a list-context query, plus
 * bare words matched against the newest message through FTS. Starts with
 * ' AND ' so it appends to listView's WHERE; empty when there is nothing to add.
 */
export function listWhere(query: string): { sql: string; params: unknown[] } {
  const { terms, predicates } = parseQuery(query, 'list')
  const parts: string[] = []
  const params: unknown[] = []
  for (const p of predicates) {
    parts.push(predicates.length > 1 ? `(${p.sql})` : p.sql)
    params.push(...p.params)
  }
  const fts = toFtsQuery(terms.join(' '))
  if (fts) {
    parts.push('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)')
    params.push(fts)
  }
  return parts.length ? { sql: ` AND ${parts.join(' AND ')}`, params } : { sql: '', params: [] }
}
```

  The `from:` predicate already lowercases and LIKEs `m.from_addr || ' ' || m.from_name`; in a list that `m` is the newest message, which is what the test expects.

- [x] **Step 4: Queries in `src/core/store/listRows.ts`.** `import { listWhere } from './search.js'`; add `query?: string` to `ListViewOptions`; in `listView`, build `const w = listWhere(opts.query ?? '')`, put `${w.sql}` right after `lr.hidden = 0`, and call `.all(folderId, ...w.params, opts.limit ?? 100, opts.offset ?? 0)`. Change `countView` to:

```ts
export function countView(folderId: number, opts: { query?: string } = {}): number {
  refreshListRows()
  const w = listWhere(opts.query ?? '')
  return (
    getDb()
      .prepare(
        `SELECT count(*) AS c FROM list_rows lr JOIN messages m ON m.id = lr.newest_id
          WHERE lr.folder_id = ? AND lr.hidden = 0${w.sql}`
      )
      .get(folderId, ...w.params) as { c: number }
  ).c
}
```

- [x] **Step 5: Create `src/core/store/splits.ts`.**

```ts
import { getDb } from './db.js'
import { countView } from './listRows.js'

export interface Split {
  /** Built-ins use a word; custom splits are `custom:<row id>`. */
  id: string
  name: string
  /** A list-context query (search.ts LIST_IS plus field operators). */
  query: string
  builtin: boolean
}

export const BUILTIN_SPLITS: Split[] = [
  { id: 'all', name: 'All', query: '', builtin: true },
  { id: 'important', name: 'Important', query: 'is:important', builtin: true },
  { id: 'other', name: 'Other', query: 'is:other', builtin: true },
  { id: 'vip', name: 'VIP', query: 'is:vip', builtin: true }
]

const PREFIX = 'custom:'

export function listSplits(): Split[] {
  const rows = getDb()
    .prepare('SELECT id, name, query FROM splits ORDER BY sort_order, id')
    .all() as { id: number; name: string; query: string }[]
  return [
    ...BUILTIN_SPLITS,
    ...rows.map((r) => ({ id: `${PREFIX}${r.id}`, name: r.name, query: r.query, builtin: false }))
  ]
}

export function saveSplit(input: { id?: string; name: string; query: string }): Split {
  const name = input.name.trim()
  const query = input.query.trim()
  if (!name || !query) throw new Error('A split needs a name and a query')
  const db = getDb()
  if (input.id?.startsWith(PREFIX)) {
    db.prepare('UPDATE splits SET name = ?, query = ? WHERE id = ?').run(
      name,
      query,
      Number(input.id.slice(PREFIX.length))
    )
    return { id: input.id, name, query, builtin: false }
  }
  const { m } = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM splits').get() as { m: number }
  const id = Number(
    db.prepare('INSERT INTO splits (name, query, sort_order) VALUES (?, ?, ?)').run(name, query, m + 1)
      .lastInsertRowid
  )
  return { id: `${PREFIX}${id}`, name, query, builtin: false }
}

export function deleteSplit(id: string): void {
  if (!id.startsWith(PREFIX)) return
  getDb().prepare('DELETE FROM splits WHERE id = ?').run(Number(id.slice(PREFIX.length)))
}

/** Conversations per split for one folder, with an optional chip query ANDed on. */
export function splitCounts(folderId: number, extraQuery = ''): Record<string, number> {
  return Object.fromEntries(
    listSplits().map((s) => [s.id, countView(folderId, { query: `${s.query} ${extraQuery}`.trim() })])
  )
}
```

- [x] **Step 6: Create `electron/ipcTriage.ts`** (later tasks add to it):

```ts
import { ipcMain } from 'electron'
import { deleteSplit, listSplits, saveSplit, splitCounts } from '../src/core/store/splits.js'

/**
 * Phase 2 triage handlers. Kept out of ipc.ts, which owns sync, compose and
 * the move hold; anything here that moves mail calls ipc.ts's holdMove.
 */
export function registerTriageIpc(): void {
  ipcMain.handle('splits:list', () => listSplits())

  ipcMain.handle('splits:save', (_e, input: { id?: string; name: string; query: string }) => {
    try {
      return { ok: true as const, split: saveSplit(input) }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  ipcMain.handle('splits:delete', (_e, id: string) => {
    deleteSplit(id)
    return { ok: true as const }
  })

  ipcMain.handle('splits:counts', (_e, folderId: number, extraQuery = '') =>
    splitCounts(folderId, extraQuery)
  )
}
```

- [x] **Step 7: Register it and pass queries.**
  - `electron/main.ts`: `import { registerTriageIpc } from './ipcTriage.js'` and call `registerTriageIpc()` on the line after `registerIpc()`.
  - `electron/ipc.ts`: `messages:list` becomes `(_e, folderId: number, limit = 100, offset = 0, query = '') => listView(folderId, { limit, offset, query })`; `messages:count` takes `(_e, folderId: number, query = '')` and calls `countView(folderId, { query })`.
  - `electron/preload.ts`: add the type

```ts
export interface Split {
  id: string
  name: string
  query: string
  builtin: boolean
}
```

    change `listMessages` to `(folderId: number, limit?: number, offset?: number, query?: string): Promise<MessageListRow[]> => ipcRenderer.invoke('messages:list', folderId, limit, offset, query)` and `countMessages` to `(folderId: number, query?: string): Promise<number> => ipcRenderer.invoke('messages:count', folderId, query)`, and add:

```ts
  listSplits: (): Promise<Split[]> => ipcRenderer.invoke('splits:list'),
  saveSplit: (input: {
    id?: string
    name: string
    query: string
  }): Promise<{ ok: true; split: Split } | { ok: false; error: string }> =>
    ipcRenderer.invoke('splits:save', input),
  deleteSplit: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke('splits:delete', id),
  splitCounts: (folderId: number, extraQuery?: string): Promise<Record<string, number>> =>
    ipcRenderer.invoke('splits:counts', folderId, extraQuery),
```

- [x] **Step 8: Run the tests.** Both new files pass. `pnpm typecheck && pnpm test`: green.

- [ ] **Step 9: Commit.**

```bash
git add src/core/store/search.ts src/core/store/listRows.ts src/core/store/splits.ts src/core/store/listQuery.test.ts src/core/store/splits.test.ts electron/ipcTriage.ts electron/ipc.ts electron/main.ts electron/preload.ts
git commit -m "[feat] list views as queries: splits and thread-state operators"
```

---

### Task 5: Registry mechanics, the undo window, and Undo anything (`z`)

**Files:**
- Create: `src/core/triage/undoWindow.ts`, `src/core/triage/undoWindow.test.ts`, `src/ui/views/TriageSettings.tsx`
- Modify: `src/ui/commands.ts`, `src/ui/commands.test.ts`, `src/ui/hooks/useHotkeys.ts`, `src/ui/hooks/useCommandChord.ts`, `src/ui/store.ts`, `src/ui/App.tsx`, `src/ui/views/Compose.tsx`, `src/ui/views/Settings.tsx`, `electron/ipc.ts`, `electron/preload.ts`

- [x] **Step 1: Write the failing tests.**

```ts
// src/core/triage/undoWindow.test.ts
import { describe, expect, it } from 'vitest'
import { undoWindowMs } from './undoWindow.js'

describe('undoWindowMs', () => {
  it('reads the four allowed choices', () => {
    for (const s of [3, 5, 10, 20]) expect(undoWindowMs({ undo_seconds: String(s) })).toBe(s * 1000)
  })
  it('falls back to 3s for anything else', () => {
    expect(undoWindowMs({})).toBe(3000)
    expect(undoWindowMs({ undo_seconds: '7' })).toBe(3000)
    expect(undoWindowMs({ undo_seconds: 'abc' })).toBe(3000)
  })
})
```

  In `src/ui/commands.test.ts`:
  - Change the import of `./hooks/useHotkeys.js` to `import { eventKey, type Mode } from './hooks/useHotkeys.js'`.
  - Replace the test `'never reuses a ⌘ chord or a sequence'` with:

```ts
  it('never reuses a ⌘ chord in the same mode, or a sequence', () => {
    const seen = new Map<string, string>()
    for (const c of COMMANDS) {
      for (const k of c.keys) {
        if (k.kind !== 'mod') continue
        for (const m of k.modes ?? ALL_MODES) {
          const slot = `${m}:${k.shift ? '⇧' : ''}${k.key.toLowerCase()}`
          expect(seen.get(slot), `${slot} is bound by ${seen.get(slot)} and ${c.id}`).toBeUndefined()
          seen.set(slot, c.id)
        }
      }
    }
    const seqs = COMMANDS.flatMap((c) =>
      c.keys.flatMap((k) => (k.kind === 'seq' ? [k.keys.join(' ')] : []))
    )
    expect(new Set(seqs).size).toBe(seqs.length)
  })
```

  - Add to the `'draws keycaps the way the sheet shows them'` test:

```ts
    expect(keyCaps({ kind: 'mod', key: 'h', shift: true })).toEqual(['⌘', '⇧', 'H'])
    expect(keyCaps({ kind: 'key', key: 'Tab' })).toEqual(['⇥'])
    expect(keyCaps({ kind: 'key', key: 'Shift+Tab' })).toEqual(['⇧', '⇥'])
```

  - Add new tests inside `describe('command registry', ...)`:

```ts
  it('tells Shift+Tab apart from Tab', () => {
    expect(eventKey({ key: 'Tab', shiftKey: true })).toBe('Shift+Tab')
    expect(eventKey({ key: 'Tab', shiftKey: false })).toBe('Tab')
    expect(eventKey({ key: 'E', shiftKey: true })).toBe('E')
  })

  it('binds z to undo in the list and in a thread', () => {
    const [b] = buildBindings('list', { undo: () => {} })
    expect([b.key, b.modes]).toEqual(['z', ['list', 'thread']])
  })
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/core/triage/undoWindow.test.ts src/ui/commands.test.ts`. Expected: FAIL (missing module, `eventKey` not exported, keycaps differ).

- [x] **Step 3: Create `src/core/triage/undoWindow.ts`.**

```ts
/** Seconds the user can pick in Settings (Scape offers the same idea). */
export const UNDO_CHOICES_S = [3, 5, 10, 20] as const
export const DEFAULT_UNDO_S = 3

/**
 * The one undo window. Main holds IMAP moves and immediate sends for this long,
 * and the renderer's toast and `z` use the hold main reports back, so the two
 * can never disagree.
 */
export function undoWindowMs(settings: Record<string, string | undefined>): number {
  const n = Number(settings.undo_seconds)
  return (UNDO_CHOICES_S as readonly number[]).includes(n) ? n * 1000 : DEFAULT_UNDO_S * 1000
}
```

- [x] **Step 4: Registry mechanics in `src/ui/commands.ts`.**
  - Replace the `mod` member of `KeySpec` with:

```ts
  /** ⌘ (Ctrl off macOS) plus a key, optionally with Shift. Without `modes`, live in every mode. */
  | { kind: 'mod'; key: string; shift?: boolean; modes?: Mode[] }
```

  - `export type Group = 'General' | 'Navigation' | 'Message' | 'List' | 'In a thread' | 'Compose'` and `const GROUP_ORDER: Group[] = ['General', 'Navigation', 'Message', 'List', 'In a thread', 'Compose']`.
  - Add `| 'undo'` to `CommandId`.
  - Add `modes: ['compose']` to the `mod` key of `compose.send`, `format.bold`, `format.italic` and `format.underline` (they are bound by the editor; this frees ⌘U in the list for Unsubscribe later).
  - Add to `COMMANDS`, after `msg.select`:

```ts
  { id: 'undo', title: 'Undo', group: 'Message', palette: true, keys: [{ kind: 'key', key: 'z', modes: LIST_THREAD }] },
```

  - Add `Tab: '⇥'` to `NAMED`, and make `keyCaps`:

```ts
export function keyCaps(spec: KeySpec): string[] {
  if (spec.kind === 'seq') return spec.keys.map(cap)
  if (spec.kind === 'mod') return ['⌘', ...(spec.shift ? ['⇧'] : []), cap(spec.key).toUpperCase()]
  const k = spec.key
  if (k === 'Shift+Tab') return ['⇧', cap('Tab')]
  // A shifted letter arrives as its capital (R); show the Shift it took.
  if (k.length === 1 && k !== k.toLowerCase()) return ['⇧', k]
  return [cap(k)]
}
```

  - Replace `buildChords` with:

```ts
export function buildChords(mode: Mode, handlers: Handlers): Chord[] {
  return live(handlers).flatMap(({ cmd, run }) =>
    cmd.keys.flatMap((k) =>
      k.kind === 'mod' && (!k.modes || k.modes.includes(mode))
        ? [{ key: k.key, shift: k.shift, handler: () => void run({ mode }) }]
        : []
    )
  )
}
```

    and add `import type { Chord } from './hooks/useCommandChord'` at the top.

- [x] **Step 5: Hooks.**
  - `src/ui/hooks/useCommandChord.ts`: export the chord type and match Shift exactly:

```ts
export interface Chord {
  key: string
  /** ⌘⇧ chords set this; a plain ⌘ chord does not fire with Shift held. */
  shift?: boolean
  handler: (e: KeyboardEvent) => void
}

export function useCommandChord(chords: Chord[]): void {
```

    and inside the loop, after the key check: `if (!!c.shift !== e.shiftKey) continue`.
  - `src/ui/hooks/useHotkeys.ts`: add and use

```ts
/** KeyboardEvent.key, except Shift+Tab, which reports 'Tab' but is its own binding. */
export function eventKey(e: { key: string; shiftKey: boolean }): string {
  return e.key === 'Tab' && e.shiftKey ? 'Shift+Tab' : e.key
}
```

    In the listener, compute `const key = eventKey(e)` before the loop and compare `b.key !== key`.

- [x] **Step 6: Main uses the setting.** In `electron/ipc.ts`:
  - `import { undoWindowMs } from '../src/core/triage/undoWindow.js'`; delete `export const UNDO_SEND_MS` and `export const UNDO_MOVE_MS`.
  - In `messages:move`: before `const batchId`, add `const holdMs = undoWindowMs(getSettings())`, use `holdMs` in `setTimeout`, return `holdMs` in both ok results (`{ ok: true as const, batchId: 0, moved: [] as number[], holdMs }` and `{ ok: true as const, batchId, moved: jobs.map((j) => j.id), holdMs }`). Move the `holdMs` line above the early `if (!plan.length) return`.
  - `QueueSendPayload.sendAt` becomes `number | null`. In `compose:queueSend`, compute `const sendAt = payload.sendAt ?? Date.now() + undoWindowMs(getSettings())` at the top of the `try`, and use `send_at: sendAt`.
  - In `compose:listScheduled`, replace `UNDO_SEND_MS` with `undoWindowMs(getSettings())`.
  - `electron/preload.ts`: `QueueSendPayload.sendAt: number | null` with the doc `/** null = now, after the undo window (main decides its length). */`; `moveMessages` result type gains `holdMs: number`.

- [x] **Step 7: One undo slot in `src/ui/store.ts`.** Delete the `UndoToast` and `MoveToast` interfaces, the `undoToast`, `moveToast`, `setUndoToast`, `setMoveToast` members, their initial values and setters. Add:

```ts
/** The single action `z` or the toast can still take back. Each new one replaces it. */
export interface UndoEntry {
  label: string
  expiresAt: number
  run: () => Promise<void>
}
```

  with `undo: UndoEntry | null` and `setUndo: (u: UndoEntry | null) => void` in `AppState`, `undo: null` initially and `setUndo: (undo) => set({ undo })`.

- [x] **Step 8: Compose lets main pick the delay.** In `src/ui/views/Compose.tsx`:
  - Change `onSent` in `Props` to `onSent: (outboxId: number, subject: string, undoMs: number, immediate: boolean) => void`.
  - Delete `SEND_DELAY_MS`; in `SCHEDULE_OPTS` set the `now` entry's `offsetMs: 0`.
  - `function scheduleAt(id: string): number | null` returns `null` for `'now'`.
  - `persistAndQueue = useCallback(async (sendAt: number | null) => {` … after `queued.ok`:

```ts
        onSent(
          queued.outboxId,
          compose.subject || '(no subject)',
          Math.max(0, queued.sendAt - Date.now()),
          sendAt === null
        )
```

- [x] **Step 9: App wiring.** In `src/ui/App.tsx`:
  - Delete the `UNDO_MOVE_MS` constant and its comment.
  - In the `useStore()` destructure replace `undoToast, setUndoToast, moveToast, setMoveToast` with `undo, setUndo`.
  - Add after `refreshUnread`:

```ts
  /** Offers `run` as the undo for `holdMs`, the window main is holding the action for. */
  const pushUndo = useCallback(
    (label: string, holdMs: number, run: () => Promise<void>) => {
      if (holdMs > 0) setUndo({ label, expiresAt: Date.now() + holdMs, run })
    },
    [setUndo]
  )

  const runUndo = useCallback(async () => {
    const u = useStore.getState().undo
    if (!u || Date.now() > u.expiresAt) return
    setUndo(null)
    await u.run()
  }, [setUndo])
```

  - In `moveSelected`, replace everything from `if (!res.batchId || !removed.length) return` to the end of the `try` with:

```ts
        if (!res.batchId || !removed.length) return
        const n = removed.length
        pushUndo(`${verb} ${n} conversation${n === 1 ? '' : 's'}`, res.holdMs, async () => {
          const r = await window.api.undoMove(res.batchId)
          if (!r.ok) return setSyncError(r.error)
          restoreRows(removed)
          void refreshUnread()
        })
```

    and fix its dependency list (`pushUndo` in, `setMoveToast` out).
  - Delete `onUndoMove` and `onUndo`. Replace `onSent` with:

```ts
  const onSent = useCallback(
    (outboxId: number, subject: string, undoMs: number, immediate: boolean) => {
      // A scheduled send is cancelled from ⌘K, not undone.
      if (!immediate) return
      pushUndo(`Sending “${subject}”`, undoMs, async () => {
        await window.api.cancelSend(outboxId)
      })
    },
    [pushUndo]
  )
```

  - Add `undo: () => runUndo(),` to `handlers` (and `runUndo` to its deps).
  - Replace the whole `{undoToast ? (...) : moveToast ? (...) : null}` block with:

```tsx
      {undo && (
        <UndoToast
          expiresAt={undo.expiresAt}
          label={undo.label}
          onUndo={() => void runUndo()}
          onDismiss={() => setUndo(null)}
        />
      )}
```

- [x] **Step 10: Settings → Undo window.** Create `src/ui/views/TriageSettings.tsx`:

```tsx
import { useEffect, useState } from 'react'

const UNDO_CHOICES = ['3', '5', '10', '20']

/**
 * Triage preferences. Reads and writes settings itself so Settings.tsx does not
 * have to thread more props through App.
 */
export function TriageSettings() {
  const [undoSecs, setUndoSecs] = useState('3')

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      if (UNDO_CHOICES.includes(s.undo_seconds)) setUndoSecs(s.undo_seconds)
    })
  }, [])

  const pickUndo = (v: string): void => {
    setUndoSecs(v)
    void window.api.setSettings({ undo_seconds: v })
  }

  return (
    <section className="settings-section">
      <h3>Undo window</h3>
      <p className="settings-note">
        How long sends and moves wait before they reach the server. Press z or use the toast to
        take them back.
      </p>
      <div className="settings-themes">
        {UNDO_CHOICES.map((v) => (
          <button key={v} type="button" data-on={undoSecs === v} onClick={() => pickUndo(v)}>
            {v}s
          </button>
        ))}
      </div>
    </section>
  )
}
```

  In `src/ui/views/Settings.tsx`, `import { TriageSettings } from './TriageSettings'` and render `<TriageSettings />` between the Theme section and the Signature section.

- [x] **Step 11: Run everything.** `pnpm typecheck && pnpm test`: green (1 more file). Then `pnpm dev` and check: trash a message, the toast counts down from 3; `z` restores it; set 10s in Settings, trash again, the toast shows 10s; send a message, `z` within the window cancels it.

- [ ] **Step 12: Commit.**

```bash
git add src/core/triage src/ui/commands.ts src/ui/commands.test.ts src/ui/hooks src/ui/store.ts src/ui/App.tsx src/ui/views/Compose.tsx src/ui/views/Settings.tsx src/ui/views/TriageSettings.tsx electron/ipc.ts electron/preload.ts
git commit -m "[feat] one undo window setting and z to undo anything"
```

---

### Task 6: Done / Not done, Spam, and the Done folder

**Files:**
- Create: `src/core/triage/movePlan.ts`, `src/core/triage/movePlan.test.ts`
- Modify: `src/core/store/folderRoles.ts`, `src/core/store/folderRoles.test.ts`, `src/core/store/repo.ts`, `src/core/store/folderRepo.test.ts`, `electron/ipc.ts`, `electron/ipcTriage.ts`, `electron/preload.ts`, `src/ui/commands.ts`, `src/ui/App.tsx`, `src/ui/views/Thread.tsx`, `src/ui/views/ActionBar.tsx`, `src/ui/views/TriageSettings.tsx`

- [x] **Step 1: Write the failing tests.**

  Append to `src/core/store/folderRoles.test.ts` (add `doneRole` to its import from `./folderRoles.js`):

```ts
describe('doneRole', () => {
  it('archives to All Mail on Gmail and to the archive folder elsewhere', () => {
    expect(doneRole('gmail')).toBe('all')
    expect(doneRole('microsoft')).toBe('archive')
    expect(doneRole('imap')).toBe('archive')
  })
})
```

  Append to `src/core/store/folderRepo.test.ts` (read its `beforeEach` first and reuse its DB setup; add `setFolderRole`, `threadMatesInFolder`, `upsertFolder`, `upsertMessage`, `folderByRole` to its repo import as needed):

```ts
describe('setFolderRole', () => {
  it('gives a free role to one folder and never steals a taken one', () => {
    const db = getDb()
    db.prepare("INSERT OR IGNORE INTO accounts (id,email) VALUES (9,'r@x.test')").run()
    upsertFolder({ account_id: 9, name: 'Archive', path: 'Archive', uidvalidity: null })
    upsertFolder({ account_id: 9, name: 'Old', path: 'Old', uidvalidity: null })
    expect(setFolderRole(9, 'Archive', 'archive')).toBe(true)
    expect(setFolderRole(9, 'Old', 'archive')).toBe(false)
    expect(folderByRole(9, 'archive')?.path).toBe('Archive')
  })
})

describe('threadMatesInFolder', () => {
  it('returns the row first, then its thread in the same folder only', () => {
    const db = getDb()
    db.prepare("INSERT OR IGNORE INTO accounts (id,email) VALUES (8,'t@x.test')").run()
    const a = upsertFolder({ account_id: 8, name: 'A', path: 'A', uidvalidity: null }).id
    const b = upsertFolder({ account_id: 8, name: 'B', path: 'B', uidvalidity: null }).id
    const put = (folder: number, uid: number, thread: string | null) =>
      upsertMessage({
        account_id: 8, folder_id: folder, uid, message_id: `<${uid}@t>`, thread_id: thread,
        in_reply_to: null, from_addr: null, from_name: null, to_addrs: null, cc_addrs: null,
        subject: null, date: uid, snippet: null
      })
    const x1 = put(a, 1, 't')
    const x2 = put(a, 2, 't')
    put(b, 3, 't')
    const lone = put(a, 4, null)
    expect(threadMatesInFolder(x2)).toEqual([x2, x1])
    expect(threadMatesInFolder(lone)).toEqual([lone])
    expect(threadMatesInFolder(99999)).toEqual([])
  })
})
```

```ts
// src/core/triage/movePlan.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { moveMessage, upsertMessage } from '../store/repo.js'
import { planMoves } from './movePlan.js'

let uid = 0
const put = (account: number, folder: number, thread: string) =>
  upsertMessage({
    account_id: account, folder_id: folder, uid: ++uid, message_id: `<${uid}@t>`, thread_id: thread,
    in_reply_to: null, from_addr: null, from_name: null, to_addrs: null, cc_addrs: null,
    subject: null, date: uid, snippet: null
  })

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'moveplan-')), 't.db'))
  uid = 0
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email,provider) VALUES (1,'a@x.test','imap'),(2,'b@gmail.com','gmail')").run()
  db.prepare(
    `INSERT INTO folders (id,account_id,path,role,uidvalidity) VALUES
       (1,1,'INBOX','inbox',7),(2,1,'Archive','archive',8),
       (3,2,'INBOX','inbox',9),(4,2,'[Gmail]/All Mail','all',10)`
  ).run()
})

const provider = (id: number) => (id === 2 ? ('gmail' as const) : ('imap' as const))

describe('planMoves', () => {
  it('moves the whole thread in that folder and records where it came from', () => {
    const a = put(1, 1, 't')
    const b = put(1, 1, 't')
    put(1, 2, 't') // already in Archive: not part of the Inbox row
    const r = planMoves([b], { role: 'archive' }, provider)
    expect(r.ok && r.plan.map((p) => [p.id, p.fromPath, p.toPath, p.uidValidity])).toEqual([
      [b, 'INBOX', 'Archive', 7],
      [a, 'INBOX', 'Archive', 7]
    ])
  })

  it('maps Done to All Mail on Gmail', () => {
    const g = put(2, 3, 'g')
    const r = planMoves([g], { role: 'archive' }, provider)
    expect(r.ok && r.plan[0].toPath).toBe('[Gmail]/All Mail')
  })

  it('skips rows already moving or already there', () => {
    const a = put(1, 1, 't')
    moveMessage(a, 2) // optimistic move: uid is now NULL
    const b = put(1, 2, 'u')
    const r = planMoves([a, b], { role: 'archive' }, provider)
    expect(r.ok && r.plan).toEqual([])
  })

  it('fails without touching anything when the account has no such folder', () => {
    getDb().prepare("UPDATE folders SET role = NULL WHERE path = 'Archive'").run()
    expect(planMoves([put(1, 1, 't')], { role: 'archive' }, provider)).toEqual({
      ok: false,
      error: 'no archive folder'
    })
  })
})
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/core/store/folderRoles.test.ts src/core/store/folderRepo.test.ts src/core/triage/movePlan.test.ts`. Expected: FAIL.

- [x] **Step 3: `doneRole`.** In `src/core/store/folderRoles.ts` add `import type { MailProvider } from '../accounts/auth.js'` and:

```ts
/** Where Done sends mail. Gmail has no \Archive: archiving there is leaving All Mail only. */
export function doneRole(provider: MailProvider): FolderRole {
  return provider === 'gmail' ? 'all' : 'archive'
}
```

- [x] **Step 4: Repo helpers** in `src/core/store/repo.ts`, after `folderByRole`:

```ts
/** Gives one folder a role if no folder of the account has it. False when taken or not found. */
export function setFolderRole(accountId: number, path: string, role: FolderRole): boolean {
  if (folderByRole(accountId, role)) return false
  return (
    getDb()
      .prepare('UPDATE folders SET role = ? WHERE account_id = ? AND path = ? AND role IS NULL')
      .run(role, accountId, path).changes > 0
  )
}
```

  and after `groupByAccount`:

```ts
/**
 * `id`, then every other message of its thread in the same folder. A list row
 * stands for its whole thread, so triaging the row must move all of them.
 */
export function threadMatesInFolder(id: number): number[] {
  const m = getDb()
    .prepare('SELECT account_id, folder_id, thread_id FROM messages WHERE id = ?')
    .get(id) as { account_id: number; folder_id: number | null; thread_id: string | null } | undefined
  if (!m) return []
  if (m.folder_id === null || m.thread_id === null) return [id]
  const rows = getDb()
    .prepare('SELECT id FROM messages WHERE account_id = ? AND folder_id = ? AND thread_id = ? ORDER BY id DESC')
    .all(m.account_id, m.folder_id, m.thread_id) as { id: number }[]
  return [id, ...rows.map((r) => r.id).filter((x) => x !== id)]
}
```

- [x] **Step 5: Create `src/core/triage/movePlan.ts`.**

```ts
import type { MailProvider } from '../accounts/auth.js'
import { doneRole, type MoveTarget } from '../store/folderRoles.js'
import {
  folderByRole,
  getFolder,
  getMessageLocation,
  groupByAccount,
  threadMatesInFolder
} from '../store/repo.js'
import type { Folder } from '../store/types.js'

/** One message's optimistic move, with everything undo and the IMAP MOVE need. */
export interface PlannedMove {
  id: number
  accountId: number
  fromFolderId: number
  fromPath: string
  uid: number
  toFolderId: number
  toPath: string
  uidValidity: number | null
}

export function resolveTarget(
  accountId: number,
  provider: MailProvider,
  target: MoveTarget
): Folder | undefined {
  if ('folderId' in target) {
    const f = getFolder(target.folderId)
    return f?.account_id === accountId ? f : undefined
  }
  // Done is sent as { role: 'archive' } by every account; Gmail's is All Mail.
  return folderByRole(accountId, target.role === 'archive' ? doneRole(provider) : target.role)
}

/**
 * Expands row ids to their thread in that folder and resolves each account's
 * destination. Resolves every destination before returning, so a missing
 * folder on one account cannot leave a half-applied move.
 */
export function planMoves(
  ids: number[],
  target: MoveTarget,
  providerOf: (accountId: number) => MailProvider | null
): { ok: true; plan: PlannedMove[] } | { ok: false; error: string } {
  const plan: PlannedMove[] = []
  const seen = new Set<number>()
  for (const [accountId, own] of groupByAccount(ids)) {
    const provider = providerOf(accountId)
    if (!provider) continue
    const dest = resolveTarget(accountId, provider, target)
    if (!dest) {
      return { ok: false, error: 'role' in target ? `no ${target.role} folder` : 'unknown folder' }
    }
    for (const rowId of own) {
      for (const id of threadMatesInFolder(rowId)) {
        if (seen.has(id)) continue
        seen.add(id)
        const loc = getMessageLocation(id)
        // No uid: already mid-move (an earlier optimistic move nulled it).
        if (!loc?.uid || loc.folder_id === dest.id) continue
        plan.push({
          id,
          accountId,
          fromFolderId: loc.folder_id,
          fromPath: loc.path,
          uid: loc.uid,
          toFolderId: dest.id,
          toPath: dest.path,
          uidValidity: getFolder(loc.folder_id)?.uidvalidity ?? null
        })
      }
    }
  }
  return { ok: true, plan }
}
```

  `providerOf` reads `accounts.provider` in tests through the stub; in main it reads the live config.

- [x] **Step 6: `holdMove` in `electron/ipc.ts`.**
  - `import { planMoves, type PlannedMove } from '../src/core/triage/movePlan.js'`.
  - Delete `interface PendingMove`, `resolveMoveTarget` and `missingTargetError`; change `pendingMoves` to `Map<number, { jobs: PlannedMove[]; timer: ReturnType<typeof setTimeout> }>`. `commitMove` and `messages:undoMove` keep working unchanged (the fields they read exist on `PlannedMove`).
  - Add above `registerIpc`:

```ts
/**
 * Applies moves to SQLite now and holds the IMAP MOVEs for the undo window.
 * Exported for triage handlers (Get me to zero) so every move shares one hold
 * and one undo path.
 */
export function holdMove(
  ids: number[],
  target: MoveTarget
):
  | { ok: true; batchId: number; moved: number[]; holdMs: number }
  | { ok: false; error: string } {
  const r = planMoves(ids, target, (accountId) => getAccount(accountId)?.config.provider ?? null)
  if (!r.ok) return r
  const holdMs = undoWindowMs(getSettings())
  if (!r.plan.length) return { ok: true, batchId: 0, moved: [], holdMs }
  for (const p of r.plan) moveMessage(p.id, p.toFolderId)
  const batchId = ++moveBatchSeq
  const timer = setTimeout(() => commitMove(batchId), holdMs)
  pendingMoves.set(batchId, { jobs: r.plan, timer })
  return { ok: true, batchId, moved: r.plan.map((p) => p.id), holdMs }
}
```

  - Replace the whole `messages:move` handler body with `ipcMain.handle('messages:move', (_e, ids: number[], target: MoveTarget) => holdMove(ids, target))`. Remove now-unused imports (`folderByRole` is still used elsewhere; `getMessageLocation`, `getFolder` may become unused — let typecheck tell you).

- [x] **Step 7: Done folder handlers** in `electron/ipcTriage.ts`:

```ts
import { doneRole } from '../src/core/store/folderRoles.js'
import { folderByRole, setFolderRole, upsertFolder } from '../src/core/store/repo.js'
import { getPool } from '../src/core/sync/pool.js'
import { getBootState } from './state.js'
```

  inside `registerTriageIpc()`:

```ts
  // Settings asks before anything is created on the server: the reverted
  // snooze created mailboxes unasked, and that is the mistake not to repeat.
  ipcMain.handle('triage:archiveStatus', () => {
    const s = getBootState()
    if (!s.ok) return { ok: false as const, error: s.error }
    return {
      ok: true as const,
      hasArchive: !!folderByRole(s.accountId, doneRole(s.config.provider)),
      host: s.config.imapHost
    }
  })

  ipcMain.handle('triage:createArchive', async () => {
    const s = getBootState()
    if (!s.ok) return { ok: false as const, error: s.error }
    if (folderByRole(s.accountId, doneRole(s.config.provider))) return { ok: true as const }
    try {
      // The server may prefix a namespace (INBOX.Archive); keep the path it returns.
      const created = await getPool(s.config).withConnection((c) => c.mailboxCreate('Archive'))
      upsertFolder({ account_id: s.accountId, name: 'Archive', path: created.path, uidvalidity: null })
      setFolderRole(s.accountId, created.path, 'archive')
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })
```

  The next sync keeps the role: `assignRoles` maps a top-level `Archive` (or `INBOX.Archive`) to `archive` by name. In `electron/preload.ts` add:

```ts
  archiveStatus: (): Promise<
    { ok: true; hasArchive: boolean; host: string } | { ok: false; error: string }
  > => ipcRenderer.invoke('triage:archiveStatus'),
  createArchive: (): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('triage:createArchive'),
```

- [x] **Step 8: Commands.** In `src/ui/commands.ts` add `| 'msg.done' | 'msg.notDone' | 'msg.spam' | 'go.done'` to `CommandId` and to `COMMANDS`:

```ts
  { id: 'go.done', title: 'Go to Done', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 'e'], modes: ['list'] }] },
```

  (after `go.junk`), and after `msg.trash`:

```ts
  { id: 'msg.done', title: 'Done', group: 'Message', palette: true, keys: [{ kind: 'key', key: 'e', modes: LIST_THREAD }] },
  { id: 'msg.notDone', title: 'Not done (back to Inbox)', group: 'Message', palette: true, keys: [{ kind: 'key', key: 'E', modes: LIST_THREAD }] },
  { id: 'msg.spam', title: 'Mark as spam', group: 'Message', palette: true, keys: [{ kind: 'key', key: '!', modes: LIST_THREAD }] },
```

- [x] **Step 9: App handlers.** In `src/ui/App.tsx`:
  - Add near the top: `const NO_ARCHIVE = 'Done needs an Archive folder. Create one in Settings → Done folder.'`
  - In `moveSelected`, make the error branch `setSyncError(res.error === 'no archive folder' ? NO_ARCHIVE : res.error)`.
  - Generalise `triageFromThread` to take the action: change it to `async (act: () => Promise<unknown>) => {` and replace `await triageSelected()` with `await act()`; drop `triageSelected` from its deps.
  - Add after `triageSelected`:

```ts
  const doneSelected = useCallback(() => moveSelected({ role: 'archive' }, 'Done'), [moveSelected])
  const notDoneSelected = useCallback(
    () => moveSelected({ role: 'inbox' }, 'Moved to Inbox'),
    [moveSelected]
  )
  const spamSelected = useCallback(() => moveSelected({ role: 'junk' }, 'Marked spam'), [moveSelected])
```

  - In `handlers`:

```ts
        'msg.trash': ({ mode: m }) => (m === 'thread' ? triageFromThread(triageSelected) : triageSelected()),
        'msg.done': ({ mode: m }) => (m === 'thread' ? triageFromThread(doneSelected) : doneSelected()),
        'msg.notDone': ({ mode: m }) =>
          m === 'thread' ? triageFromThread(notDoneSelected) : notDoneSelected(),
        'msg.spam': ({ mode: m }) => (m === 'thread' ? triageFromThread(spamSelected) : spamSelected()),
        'go.done': () => gotoFolder('archive'),
```

    and add the three new callbacks to the deps. `gotoFolder('archive')` does nothing on Gmail, whose All Mail is not synced (known gap, see Self-review notes).
  - `<Thread ... onTrash={() => void triageFromThread(triageSelected)} onDone={() => void triageFromThread(doneSelected)} />` and `<ActionBar ... onDone={() => void doneSelected()} />`.

- [x] **Step 10: Buttons.**
  - `src/ui/views/Thread.tsx`: add `onDone: () => void` to `Props` and the destructure; import `Archive` from `lucide-react`; put this first inside `.thread-actions`:

```tsx
          <button type="button" title="Done (e)" aria-label="Done" onClick={onDone}>
            <Archive size={15} strokeWidth={2} />
          </button>
```

  - `src/ui/views/ActionBar.tsx`: add `onDone: () => void` to `Props` and the destructure, and a Done button immediately before the Trash button, copying the Trash button's markup with `title="Done (e)"`, `aria-label="Done"`, the `Archive` icon and `onClick={onDone}`.

- [x] **Step 11: Settings → Done folder.** In `src/ui/views/TriageSettings.tsx` add state and the section (render it after the Undo window section):

```tsx
  const [archive, setArchive] = useState<{ hasArchive: boolean; host: string } | null>(null)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    void window.api.archiveStatus().then((r) => {
      if (r.ok) setArchive({ hasArchive: r.hasArchive, host: r.host })
    })
  }, [])

  const createArchive = async (): Promise<void> => {
    setConfirming(false)
    const r = await window.api.createArchive()
    if (!r.ok) return setArchiveError(r.error)
    setArchiveError(null)
    setArchive((a) => (a ? { ...a, hasArchive: true } : a))
  }
```

```tsx
      <section className="settings-section">
        <h3>Done folder</h3>
        {archive?.hasArchive ? (
          <p className="settings-note">Done (e) moves conversations to your archive folder.</p>
        ) : confirming ? (
          <>
            <p className="settings-note">
              This creates a folder named “Archive” on {archive?.host}. Nothing else changes.
            </p>
            <div className="settings-themes">
              <button type="button" onClick={() => void createArchive()}>Create it</button>
              <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <p className="settings-note">
              This mailbox has no archive folder, so Done (e) has nowhere to put mail yet.
            </p>
            <div className="settings-themes">
              <button type="button" onClick={() => setConfirming(true)}>Create an Archive folder…</button>
            </div>
          </>
        )}
        {archiveError && <p className="settings-error">{archiveError}</p>}
      </section>
```

- [x] **Step 12: Run everything.** `pnpm typecheck && pnpm test`: green. In `pnpm dev` on the Exmail account: `e` shows the "Done needs an Archive folder" banner; Settings → Done folder → Create → confirm; `e` now moves the whole thread (check a multi-message thread) and `z` brings it back; `g e` opens Archive; `E` there moves it back to Inbox; `!` moves to Junk.

- [ ] **Step 13: Commit.**

```bash
git add src/core/store/folderRoles.ts src/core/store/folderRoles.test.ts src/core/store/repo.ts src/core/store/folderRepo.test.ts src/core/triage/movePlan.ts src/core/triage/movePlan.test.ts electron/ipc.ts electron/ipcTriage.ts electron/preload.ts src/ui/commands.ts src/ui/App.tsx src/ui/views/Thread.tsx src/ui/views/ActionBar.tsx src/ui/views/TriageSettings.tsx
git commit -m "[feat] done, not done and spam; create an archive folder only on request"
```

---

### Task 7: Split inbox, filter chips, date grouping and selection keys

**Files:**
- Create: `src/ui/chips.ts`, `src/ui/chips.test.ts`, `src/ui/listGroups.ts`, `src/ui/listGroups.test.ts`, `src/ui/views/SplitBar.tsx`
- Modify: `src/ui/store.ts`, `src/ui/selection.test.ts`, `src/ui/commands.ts`, `src/ui/App.tsx`, `src/ui/views/MessageList.tsx`, `src/ui/views/TriageSettings.tsx`, `src/ui/styles/app.css`

- [x] **Step 1: Write the failing tests.**

```ts
// src/ui/chips.test.ts
import { describe, expect, it } from 'vitest'
import { CHIPS, viewQuery } from './chips.js'

describe('viewQuery', () => {
  it('ANDs the split query and the chip query', () => {
    expect(viewQuery('is:important', 'unread')).toBe('is:important is:unread')
    expect(viewQuery('', 'needsReply')).toBe('is:needs-reply')
    expect(viewQuery('from:bob', null)).toBe('from:bob')
    expect(viewQuery('', null)).toBe('')
  })
  it('offers Unread, Needs reply, Waiting and Starred', () => {
    expect(CHIPS.map((c) => c.label)).toEqual(['Unread', 'Needs reply', 'Waiting', 'Starred'])
  })
})
```

```ts
// src/ui/listGroups.test.ts
import { describe, expect, it } from 'vitest'
import { dateGroup, withDateGroups } from './listGroups.js'

// Thursday 29 October 2026, 10:00 local.
const NOW = new Date(2026, 9, 29, 10, 0)
const at = (m: number, d: number, h = 9) => new Date(2026, m, d, h).getTime()

describe('date groups', () => {
  it('labels days, weeks and months', () => {
    expect(dateGroup(at(9, 29), NOW)).toBe('Today')
    expect(dateGroup(at(9, 28), NOW)).toBe('Yesterday')
    expect(dateGroup(at(9, 26), NOW)).toBe('This week')
    expect(dateGroup(at(9, 19), NOW)).toBe('Last week')
    expect(dateGroup(at(9, 18), NOW)).toBe('October 2026')
    expect(dateGroup(at(8, 30), NOW)).toBe('September 2026')
    expect(dateGroup(null, NOW)).toBe('Older')
  })

  it('puts a header before each run of rows', () => {
    const rows = [{ date: at(9, 29) }, { date: at(9, 29, 8) }, { date: at(9, 20) }]
    expect(withDateGroups(rows, NOW)).toEqual([
      { kind: 'header', label: 'Today' },
      { kind: 'row', index: 0 },
      { kind: 'row', index: 1 },
      { kind: 'header', label: 'Last week' },
      { kind: 'row', index: 2 }
    ])
  })
})
```

  Append to `src/ui/selection.test.ts`:

```ts
import { useStore } from './store.js'

describe('extendSelection (⇧J / ⇧K)', () => {
  it('checks the cursor row and the next one, and moves the cursor', () => {
    useStore.setState({
      rows: ROWS.map((r) => ({ id: r.id })) as never,
      selectedIndex: 2,
      checkedIds: [],
      lastCheckedIndex: null
    })
    useStore.getState().extendSelection(1)
    useStore.getState().extendSelection(1)
    expect(useStore.getState().checkedIds).toEqual([102, 103, 104])
    expect(useStore.getState().selectedIndex).toBe(4)
    useStore.getState().extendSelection(-10)
    expect(useStore.getState().selectedIndex).toBe(0)
  })
})
```

  (Move the new `import` line up to the file's other imports.)

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/ui/chips.test.ts src/ui/listGroups.test.ts src/ui/selection.test.ts`. Expected: FAIL.

- [x] **Step 3: Create `src/ui/chips.ts`.**

```ts
export type ChipId = 'unread' | 'needsReply' | 'waiting' | 'starred'

/** Filter chips above the list (Scape). Each is a list-context query, so it also works as a split. */
export const CHIPS: { id: ChipId; label: string; query: string }[] = [
  { id: 'unread', label: 'Unread', query: 'is:unread' },
  { id: 'needsReply', label: 'Needs reply', query: 'is:needs-reply' },
  { id: 'waiting', label: 'Waiting', query: 'is:waiting' },
  { id: 'starred', label: 'Starred', query: 'is:starred' }
]

export function viewQuery(splitQuery: string, chip: ChipId | null): string {
  const chipQuery = CHIPS.find((c) => c.id === chip)?.query ?? ''
  return [splitQuery.trim(), chipQuery].filter(Boolean).join(' ')
}
```

- [x] **Step 4: Create `src/ui/listGroups.ts`.**

```ts
export type ListItem = { kind: 'header'; label: string } | { kind: 'row'; index: number }

// Fixed English names: toLocaleString would make labels (and tests) depend on the machine.
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

/** Built from calendar fields, not ms arithmetic, so DST days are still 1 day. */
function dayStart(now: Date, offsetDays = 0): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays).getTime()
}

export function dateGroup(epoch: number | null, now: Date): string {
  if (!epoch) return 'Older'
  if (epoch >= dayStart(now)) return 'Today'
  if (epoch >= dayStart(now, -1)) return 'Yesterday'
  const sinceMonday = (now.getDay() + 6) % 7
  if (epoch >= dayStart(now, -sinceMonday)) return 'This week'
  if (epoch >= dayStart(now, -sinceMonday - 7)) return 'Last week'
  const d = new Date(epoch)
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** Rows with a header before each run of the same group. Headers are display only. */
export function withDateGroups(rows: { date: number | null }[], now: Date): ListItem[] {
  const out: ListItem[] = []
  let last: string | null = null
  rows.forEach((r, index) => {
    const label = dateGroup(r.date, now)
    if (label !== last) {
      out.push({ kind: 'header', label })
      last = label
    }
    out.push({ kind: 'row', index })
  })
  return out
}
```

- [x] **Step 5: Store state** in `src/ui/store.ts`. `import type { ChipId } from './chips'`; add to `AppState`:

```ts
  /** Active split in the Inbox ('all' = no split). */
  splitId: string
  /** Active filter chip, any folder. */
  chip: ChipId | null
  groupByDate: boolean
  setSplit: (id: string) => void
  setChip: (chip: ChipId | null) => void
  setGroupByDate: (on: boolean) => void
  /** ⇧J / ⇧K: check the cursor row and the next one, and move the cursor there. */
  extendSelection: (delta: number) => void
```

  initial `splitId: 'all', chip: null, groupByDate: false`, and:

```ts
  setSplit: (splitId) => set({ splitId }),
  setChip: (chip) => set({ chip }),
  setGroupByDate: (groupByDate) => set({ groupByDate }),
  extendSelection: (delta) => {
    const { rows, selectedIndex, checkedIds } = get()
    if (!rows.length) return
    const next = Math.max(0, Math.min(rows.length - 1, selectedIndex + delta))
    const ids = new Set(checkedIds)
    if (rows[selectedIndex]) ids.add(rows[selectedIndex].id)
    if (rows[next]) ids.add(rows[next].id)
    set({ checkedIds: [...ids], selectedIndex: next, lastCheckedIndex: next })
  },
```

- [x] **Step 6: Commands.** Add to `CommandId`: `'split.next' | 'split.prev' | 'filter.unread' | 'filter.needsReply' | 'filter.waiting' | 'filter.starred' | 'list.groupByDate' | 'select.all' | 'select.extendDown' | 'select.extendUp'`, and to `COMMANDS` (after the Message group entries):

```ts
  { id: 'split.next', title: 'Next split', group: 'List', keys: [{ kind: 'key', key: 'Tab', modes: ['list'] }] },
  { id: 'split.prev', title: 'Previous split', group: 'List', keys: [{ kind: 'key', key: 'Shift+Tab', modes: ['list'] }] },
  { id: 'filter.unread', title: 'Filter: unread', group: 'List', palette: true, keys: [{ kind: 'key', key: 'U', modes: ['list'] }] },
  { id: 'filter.needsReply', title: 'Filter: needs reply', group: 'List', palette: true, keys: [{ kind: 'key', key: 'R', modes: ['list'] }] },
  { id: 'filter.waiting', title: 'Filter: waiting on others', group: 'List', palette: true, keys: [] },
  { id: 'filter.starred', title: 'Filter: starred', group: 'List', palette: true, keys: [{ kind: 'key', key: 'S', modes: ['list'] }] },
  { id: 'list.groupByDate', title: 'Group by date', group: 'List', palette: true, keys: [{ kind: 'key', key: 'D', modes: ['list'] }] },
  { id: 'select.all', title: 'Select all', group: 'List', keys: [{ kind: 'mod', key: 'a', modes: ['list'] }] },
  { id: 'select.extendDown', title: 'Extend selection down', group: 'List', keys: [{ kind: 'key', key: 'J', modes: ['list'] }] },
  { id: 'select.extendUp', title: 'Extend selection up', group: 'List', keys: [{ kind: 'key', key: 'K', modes: ['list'] }] },
```

  `R` stays Reply all in a thread; the registry test allows one key in different modes.

- [x] **Step 7: Create `src/ui/views/SplitBar.tsx`.**

```tsx
import type { Split } from '../../../electron/preload'
import { CHIPS, type ChipId } from '../chips'

interface Props {
  /** Splits show in the Inbox only; chips show everywhere. */
  splits: Split[] | null
  counts: Record<string, number>
  activeSplit: string
  chip: ChipId | null
  onSplit: (id: string) => void
  onChip: (id: ChipId) => void
}

export function SplitBar({ splits, counts, activeSplit, chip, onSplit, onChip }: Props) {
  return (
    <div className="split-bar">
      {splits && (
        <div className="split-tabs" role="tablist" aria-label="Splits">
          {splits.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === activeSplit}
              onClick={(e) => {
                e.currentTarget.blur()
                onSplit(s.id)
              }}
            >
              {s.name}
              <span className="split-count">{counts[s.id] ?? 0}</span>
            </button>
          ))}
        </div>
      )}
      <div className="split-chips">
        {CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            data-on={chip === c.id}
            onClick={(e) => {
              e.currentTarget.blur()
              onChip(c.id)
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  )
}
```

- [x] **Step 8: MessageList grouping** (`src/ui/views/MessageList.tsx`):
  - Import `useMemo`, and `withDateGroups, type ListItem` from `'../listGroups'`. Add `const GROUP_HEIGHT = 24` and the prop `groupByDate?: boolean` (default `false`).
  - Before the virtualizer:

```tsx
  const items = useMemo<ListItem[]>(
    () =>
      groupByDate
        ? withDateGroups(rows, new Date())
        : rows.map((_, index) => ({ kind: 'row' as const, index })),
    [rows, groupByDate]
  )
  /** Row index -> item index, so the keyboard cursor can scroll a grouped list. */
  const itemOfRow = useMemo(() => {
    const out: number[] = []
    items.forEach((it, i) => {
      if (it.kind === 'row') out[it.index] = i
    })
    return out
  }, [items])
```

  - Virtualizer: `count: items.length`, `estimateSize: (i) => (items[i]?.kind === 'header' ? GROUP_HEIGHT : ROW_HEIGHT)`.
  - Scroll effect: `virtualizer.scrollToIndex(itemOfRow[selectedIndex] ?? 0, { align: 'auto' })` with `itemOfRow` in deps.
  - In the render map, start with:

```tsx
          {virtualItems.map((item) => {
            const it = items[item.index]
            if (it.kind === 'header')
              return (
                <div key={`h${item.index}`} className="row-group" style={{ height: GROUP_HEIGHT }}>
                  {it.label}
                </div>
              )
            const index = it.index
            const r = rows[index]
```

    (rename the existing `const items = virtualizer.getVirtualItems()` to `virtualItems` and update its two uses), and replace every `item.index` inside the row JSX with `index`.

- [x] **Step 9: App wiring** (`src/ui/App.tsx`):
  - Imports: `SplitBar`, `viewQuery, CHIPS, type ChipId` from `'./chips'`, `type Split` from the preload types.
  - Destructure `splitId, chip, groupByDate, setSplit, setChip, setGroupByDate, extendSelection` from `useStore()`.
  - State and helpers (near `fetchPage`):

```ts
  const [splits, setSplits] = useState<Split[]>([])
  const splitsRef = useRef<Split[]>([])
  const [splitCounts, setSplitCounts] = useState<Record<string, number>>({})
  // Reloaded when Settings closes, since custom splits are edited there.
  useEffect(() => {
    if (settingsOpen) return
    void window.api.listSplits().then((s) => {
      splitsRef.current = s
      setSplits(s)
    })
  }, [settingsOpen])

  const isInbox = useCallback(
    (fid: number | null) => useStore.getState().folders.find((f) => f.id === fid)?.role === 'inbox',
    []
  )

  /** What the list on screen shows: the split (Inbox only) ANDed with the chip. */
  const currentQuery = useCallback(
    (folderId: number): string => {
      const { splitId: sid, chip: c } = useStore.getState()
      const split = isInbox(folderId) ? splitsRef.current.find((s) => s.id === sid) : undefined
      return viewQuery(split?.query ?? '', c)
    },
    [isInbox]
  )
```

    `settingsOpen` is declared further down today; move its `useState` line above this block.
  - `fetchPage`: `window.api.listMessages(folderId, PAGE_SIZE, offset, currentQuery(folderId))` (deps: add `currentQuery`).
  - `loadRows`: replace `setTotalRows(await window.api.countMessages(folderId))` with `setTotalRows(await window.api.countMessages(folderId, currentQuery(folderId)))` and add:

```ts
      if (isInbox(folderId))
        setSplitCounts(await window.api.splitCounts(folderId, viewQuery('', useStore.getState().chip)))
```

    Do the same `countMessages(folderId, currentQuery(folderId))` change in `goToPage`.
  - Load the grouping preference in the existing settings effect: `setGroupByDate(s.list_group_by_date === '1')`.
  - Handlers:

```ts
  const reloadActive = useCallback(() => {
    const fid = useStore.getState().activeFolderId
    if (fid) void loadRows(fid)
  }, [loadRows])

  const cycleSplit = useCallback(
    (delta: number) => {
      const list = splitsRef.current
      if (!isInbox(useStore.getState().activeFolderId) || !list.length) return
      const i = list.findIndex((s) => s.id === useStore.getState().splitId)
      setSplit(list[(i + delta + list.length) % list.length].id)
      reloadActive()
    },
    [isInbox, setSplit, reloadActive]
  )

  const toggleChip = useCallback(
    (id: ChipId) => {
      setChip(useStore.getState().chip === id ? null : id)
      reloadActive()
    },
    [setChip, reloadActive]
  )
```

    and in `handlers`:

```ts
        'split.next': () => cycleSplit(1),
        'split.prev': () => cycleSplit(-1),
        'filter.unread': () => toggleChip('unread'),
        'filter.needsReply': () => toggleChip('needsReply'),
        'filter.waiting': () => toggleChip('waiting'),
        'filter.starred': () => toggleChip('starred'),
        'list.groupByDate': () => {
          const on = !useStore.getState().groupByDate
          setGroupByDate(on)
          void window.api.setSettings({ list_group_by_date: on ? '1' : '0' })
        },
        'select.all': () => setCheckedAll(useStore.getState().rows.map((r) => r.id)),
        'select.extendDown': () => extendSelection(1),
        'select.extendUp': () => extendSelection(-1),
```

    (add the new callbacks and setters to the deps).
  - Render, between the sync-error banner and the `ActionBar`, when not in Drafts:

```tsx
            {active && active.role !== 'drafts' && (
              <SplitBar
                splits={active.role === 'inbox' ? splits : null}
                counts={splitCounts}
                activeSplit={splitId}
                chip={chip}
                onSplit={(id) => {
                  setSplit(id)
                  reloadActive()
                }}
                onChip={toggleChip}
              />
            )}
```

  - Pass `groupByDate={groupByDate}` to `<MessageList>`; when a chip or a non-`all` split is active, pass `emptySub="Nothing matches this view"`.
  - Remove the now-unused `CHIPS` import if you did not use it.

- [x] **Step 10: Settings → Splits.** In `src/ui/views/TriageSettings.tsx` add a section after Done folder:

```tsx
  const [splits, setSplits] = useState<Split[]>([])
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [splitError, setSplitError] = useState<string | null>(null)
  useEffect(() => {
    void window.api.listSplits().then(setSplits)
  }, [])

  const addSplit = async (): Promise<void> => {
    const r = await window.api.saveSplit({ name, query })
    if (!r.ok) return setSplitError(r.error)
    setSplitError(null)
    setName('')
    setQuery('')
    setSplits(await window.api.listSplits())
  }
```

```tsx
      <section className="settings-section">
        <h3>Splits</h3>
        <p className="settings-note">
          Tabs across the Inbox, cycled with Tab. A split is a search: from:, to:, subject:,
          is:unread, is:needs-reply, is:waiting, is:vip, is:bulk.
        </p>
        <ul className="settings-splits">
          {splits.map((s) => (
            <li key={s.id}>
              <span>{s.name}</span>
              <code>{s.query || '(everything)'}</code>
              {!s.builtin && (
                <button
                  type="button"
                  onClick={async () => {
                    await window.api.deleteSplit(s.id)
                    setSplits(await window.api.listSplits())
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="settings-split-form">
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="from:github.com" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="button" onClick={() => void addSplit()}>Add</button>
        </div>
        {splitError && <p className="settings-error">{splitError}</p>}
      </section>
```

  with `import type { Split } from '../../../electron/preload'`.

- [x] **Step 11: Styles** in `src/ui/styles/app.css`, using existing tokens only:
  - `.split-bar`: flex row, `gap: var(--space-3)`, `padding: var(--space-2) var(--space-4)`, bottom border `1px solid var(--border)`, `align-items: center`, `overflow-x: auto`.
  - `.split-tabs button`: `font-size: var(--text-sm)`, `color: var(--text-secondary)`, `padding: var(--space-1) var(--space-2)`, `border-radius: var(--radius-sm)`; `[aria-selected='true']` gets `color: var(--text-primary)` and `background: var(--surface-selected)`. `.split-count`: `margin-left: var(--space-1)`, `color: var(--text-tertiary)`, `font-size: var(--text-xs)`.
  - `.split-chips`: `margin-left: auto`, flex, `gap: var(--space-1)`; buttons styled like `.settings-themes button` but `padding: 2px var(--space-2)` and `font-size: var(--text-xs)`; `[data-on='true']` uses `border-color: var(--accent); color: var(--accent)`.
  - `.row-group`: `display: flex; align-items: flex-end; padding: 0 var(--space-4) var(--space-1)`, `font-size: var(--text-xs)`, `color: var(--text-tertiary)`, `text-transform: uppercase`, `letter-spacing: 0.04em`.
  - `.settings-splits li` and `.settings-split-form`: flex rows with `gap: var(--space-2)`; inputs borrow the border and radius of `.settings-signature`.

- [x] **Step 12: Run everything.** `pnpm typecheck && pnpm test`: green (2 more files). In `pnpm dev`: Inbox shows All / Important / Other / VIP with counts; Tab and ⇧Tab cycle; ⇧U and ⇧R toggle chips and the counts follow; ⇧D adds date headers and j/k still scroll correctly; ⌘A checks the page; ⇧J/⇧K extend the selection; a custom split added in Settings appears after closing Settings.

- [ ] **Step 13: Commit.**

```bash
git add src/ui/chips.ts src/ui/chips.test.ts src/ui/listGroups.ts src/ui/listGroups.test.ts src/ui/selection.test.ts src/ui/store.ts src/ui/commands.ts src/ui/App.tsx src/ui/views/SplitBar.tsx src/ui/views/MessageList.tsx src/ui/views/TriageSettings.tsx src/ui/styles/app.css
git commit -m "[feat] split inbox, filter chips, date grouping and selection keys"
```

---

### Task 8: Remind me (local only)

`h` hides a thread from the local Inbox until a time; nothing moves on the server. `⌘⇧H` in compose sets "remind me if no reply" on the outgoing message. `g h` opens the Reminders view.

**Files:**
- Create: `src/core/triage/reminders.ts`, `src/core/triage/reminders.test.ts`, `src/ui/when.ts`, `src/ui/when.test.ts`, `src/ui/views/RemindPicker.tsx`, `electron/reminderWorker.ts`
- Modify: `src/core/send/outbox.ts`, `src/core/send/flush.ts`, `electron/ipc.ts`, `electron/ipcTriage.ts`, `electron/main.ts`, `electron/preload.ts`, `src/ui/commands.ts`, `src/ui/store.ts`, `src/ui/App.tsx`, `src/ui/views/Compose.tsx`, `src/ui/views/Sidebar.tsx`, `src/ui/views/MessageList.tsx`, `src/ui/styles/app.css`

- [x] **Step 1: Write the failing tests.**

```ts
// src/ui/when.test.ts
import { describe, expect, it } from 'vitest'
import { parseWhen, PRESETS } from './when.js'

// Thursday 29 October 2026, 10:00 local.
const NOW = new Date(2026, 9, 29, 10, 0)
const d = (y: number, m: number, day: number, h = 8, min = 0) => new Date(y, m, day, h, min)

describe('parseWhen', () => {
  it.each([
    ['tomorrow', d(2026, 9, 30)],
    ['tomorrow 3pm', d(2026, 9, 30, 15)],
    ['tomorrow at 15:30', d(2026, 9, 30, 15, 30)],
    ['fri', d(2026, 9, 30)],
    ['thursday', d(2026, 10, 5)],
    ['monday at 9am', d(2026, 10, 2, 9)],
    ['next week', d(2026, 10, 2)],
    ['weekend', d(2026, 9, 31)],
    ['3pm', d(2026, 9, 29, 15)],
    ['9am', d(2026, 9, 30, 9)],
    ['at 4:30pm', d(2026, 9, 29, 16, 30)],
    ['tonight', d(2026, 9, 29, 20)],
    ['later', d(2026, 9, 29, 13)],
    ['in 2 hours', d(2026, 9, 29, 12)],
    ['in 30 min', d(2026, 9, 29, 10, 30)],
    ['in 3 days', d(2026, 10, 1)],
    ['in 1 week', d(2026, 10, 5)],
    ['in 1 month', d(2026, 10, 29)],
    ['2026-11-03', d(2026, 10, 3)],
    ['nov 3 5pm', d(2026, 10, 3, 17)],
    ['3 nov', d(2026, 10, 3)],
    ['jan 5', d(2027, 0, 5)]
  ])('%s', (text, want) => {
    expect(parseWhen(text, NOW)).toEqual(want)
  })

  it.each(['', 'banana', '3', '25:00', 'in lots of days'])('rejects %j', (text) => {
    expect(parseWhen(text, NOW)).toBeNull()
  })

  it('has presets that all land in the future', () => {
    for (const p of PRESETS) expect(p.at(NOW).getTime()).toBeGreaterThan(NOW.getTime())
  })
})
```

```ts
// src/core/triage/reminders.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { listView } from '../store/listRows.js'
import { upsertMessage } from '../store/repo.js'
import {
  clearReminder,
  listReminderRows,
  reminderOutcome,
  setReminder,
  wakeDueReminders
} from './reminders.js'

const ME = 'me@x.test'
let uid = 0
const put = (folder: number, o: { id: string; thread: string; from: string; date: number }) =>
  upsertMessage({
    account_id: 1, folder_id: folder, uid: ++uid, message_id: o.id, thread_id: o.thread,
    in_reply_to: null, from_addr: o.from, from_name: null, to_addrs: '[]', cc_addrs: '[]',
    subject: o.thread, date: o.date, snippet: null, flags: '[]'
  })

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'remind-')), 't.db'))
  uid = 0
  getDb().prepare('INSERT INTO accounts (id,email) VALUES (1,?)').run(ME)
  getDb().prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox'),(2,1,'Sent','sent')").run()
})

describe('reminderOutcome', () => {
  const r = { remind_at: 1000, created_at: 100 }
  it('waits until due, then fires', () => {
    expect(reminderOutcome(r, null, 999)).toBe('wait')
    expect(reminderOutcome(r, null, 1000)).toBe('fire')
  })
  it('drops once someone replied after it was set', () => {
    expect(reminderOutcome(r, 150, 500)).toBe('drop')
    expect(reminderOutcome(r, 50, 1000)).toBe('fire')
  })
})

describe('reminders', () => {
  it('hide the thread from the Inbox while pending, and bump it when fired', () => {
    put(1, { id: '<a@t>', thread: 'a', from: 'x@y.test', date: 100 })
    put(1, { id: '<b@t>', thread: 'b', from: 'x@y.test', date: 200 })
    setReminder({ accountId: 1, messageId: '<a@t>', subject: 'a', remindAt: 5000, ifNoReply: false, now: 1000 })
    expect(listView(1).map((r) => r.subject)).toEqual(['b'])
    expect(listReminderRows(1).map((r) => [r.subject, r.remind_at])).toEqual([['a', 5000]])

    expect(wakeDueReminders(4999)).toEqual([])
    expect(wakeDueReminders(5000)).toEqual([{ accountId: 1, subject: 'a' }])
    const rows = listView(1)
    expect(rows.map((r) => [r.subject, r.reminder_fired])).toEqual([['a', 1], ['b', 0]])
  })

  it('come back early when a reply arrives, and are dropped at wake', () => {
    put(2, { id: '<s@t>', thread: 's', from: ME, date: 100 })
    setReminder({ accountId: 1, messageId: '<s@t>', subject: 's', remindAt: 5000, ifNoReply: true, now: 1000 })
    put(1, { id: '<r@t>', thread: 's', from: 'x@y.test', date: 2000 })
    expect(listView(1).map((r) => r.subject)).toEqual(['s'])
    expect(wakeDueReminders(6000)).toEqual([])
    expect(listReminderRows(1)).toEqual([])
  })

  it('never hide anything outside the Inbox', () => {
    put(2, { id: '<s@t>', thread: 's', from: ME, date: 100 })
    setReminder({ accountId: 1, messageId: '<s@t>', subject: 's', remindAt: 5000, ifNoReply: true, now: 1000 })
    expect(listView(2).map((r) => r.subject)).toEqual(['s'])
  })

  it('can be cleared', () => {
    put(1, { id: '<a@t>', thread: 'a', from: 'x@y.test', date: 100 })
    setReminder({ accountId: 1, messageId: '<a@t>', subject: 'a', remindAt: 5000, ifNoReply: false, now: 1000 })
    expect(clearReminder(1, '<a@t>')).toBe(true)
    expect(listView(1).map((r) => r.subject)).toEqual(['a'])
  })
})
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/ui/when.test.ts src/core/triage/reminders.test.ts`. Expected: FAIL.

- [x] **Step 3: Create `src/ui/when.ts`.**

```ts
/** Natural-language times for Remind me. Pure; `now` is injected so tests are fixed. */

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
]
/** Superhuman's default: a reminder with no time lands at the start of the working day. */
const DEFAULT_HOUR = 8

function at(base: Date, h: number, m = 0): Date {
  const d = new Date(base)
  d.setHours(h, m, 0, 0)
  return d
}

function addDays(base: Date, n: number): Date {
  const d = new Date(base)
  d.setDate(d.getDate() + n)
  return d
}

/** The next `weekday` (0 = Sunday) strictly after today. */
function nextWeekday(now: Date, weekday: number): Date {
  return addDays(now, (weekday - now.getDay() + 7) % 7 || 7)
}

export function laterToday(now: Date): Date {
  const d = new Date(now.getTime() + 3 * 3_600_000)
  d.setMinutes(0, 0, 0)
  return d
}

/** '3pm', '3:30pm', '15:00', 'noon'. A bare number is not a time: '3' could be a day. */
export function parseTime(s: string): { h: number; m: number } | null {
  const t = s.trim().toLowerCase()
  if (t === 'noon') return { h: 12, m: 0 }
  if (t === 'midnight') return { h: 0, m: 0 }
  const mt = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t)
  if (!mt) return null
  let h = Number(mt[1])
  const m = Number(mt[2] ?? 0)
  const ap = mt[3]
  if (m > 59) return null
  if (ap) {
    if (h < 1 || h > 12) return null
    if (ap === 'pm' && h !== 12) h += 12
    if (ap === 'am' && h === 12) h = 0
  } else if (mt[2] === undefined) {
    return null
  }
  return h > 23 ? null : { h, m }
}

function monthIndex(word: string): number {
  return word.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(word)) : -1
}

/** A Date in the future, or null when the text is not a time we understand. */
export function parseWhen(text: string, now: Date): Date | null {
  let s = text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^(on|at) /, '')
  if (!s) return null

  let time: { h: number; m: number } | null = parseTime(s)
  if (time) {
    s = ''
  } else {
    const tail = /^(.*?)(?: at)? (\S+)$/.exec(s)
    const t = tail ? parseTime(tail[2]) : null
    if (tail && t) {
      time = t
      s = tail[1].trim()
    }
  }
  const h = time?.h ?? DEFAULT_HOUR
  const m = time?.m ?? 0
  const future = (d: Date): Date | null => (d.getTime() > now.getTime() ? d : null)

  if (s === '') {
    const d = at(now, h, m)
    return d > now ? d : addDays(d, 1)
  }
  if (s === 'today') return future(at(now, h, m))
  if (s === 'later' || s === 'later today') return laterToday(now)
  if (s === 'tonight') {
    const d = at(now, time?.h ?? 20, m)
    return d > now ? d : addDays(d, 1)
  }
  if (s === 'tomorrow') return at(addDays(now, 1), h, m)
  if (s === 'next week') return at(nextWeekday(now, 1), h, m)
  if (s === 'weekend' || s === 'this weekend') return at(nextWeekday(now, 6), h, m)

  const rel = /^in (\d+) ?(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|months?)$/.exec(s)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2]
    if (unit.startsWith('mo')) {
      const d = at(now, h, m)
      d.setMonth(d.getMonth() + n)
      return d
    }
    if (unit.startsWith('m')) return new Date(now.getTime() + n * 60_000)
    if (unit.startsWith('h')) return new Date(now.getTime() + n * 3_600_000)
    if (unit.startsWith('w')) return at(addDays(now, 7 * n), h, m)
    return at(addDays(now, n), h, m)
  }

  const day = DAYS.findIndex((dn) => s === dn || s === dn.slice(0, 3) || s === `next ${dn}`)
  if (day >= 0) return at(nextWeekday(now, day), h, m)

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (iso) return future(new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), h, m))

  const md = /^([a-z]+) (\d{1,2})$/.exec(s) ?? /^(\d{1,2}) ([a-z]+)$/.exec(s)
  if (md) {
    const word = /\d/.test(md[1]) ? md[2] : md[1]
    const num = Number(/\d/.test(md[1]) ? md[1] : md[2])
    const mi = monthIndex(word)
    if (mi < 0 || num < 1 || num > 31) return null
    const d = new Date(now.getFullYear(), mi, num, h, m)
    return d > now ? d : new Date(now.getFullYear() + 1, mi, num, h, m)
  }
  return null
}

export const PRESETS: { id: string; label: string; at: (now: Date) => Date }[] = [
  { id: 'later', label: 'Later today', at: laterToday },
  { id: 'tomorrow', label: 'Tomorrow', at: (n) => at(addDays(n, 1), DEFAULT_HOUR) },
  { id: 'weekend', label: 'This weekend', at: (n) => at(nextWeekday(n, 6), DEFAULT_HOUR) },
  { id: 'nextWeek', label: 'Next week', at: (n) => at(nextWeekday(n, 1), DEFAULT_HOUR) },
  {
    id: 'month',
    label: 'In a month',
    at: (n) => {
      const d = at(n, DEFAULT_HOUR)
      d.setMonth(d.getMonth() + 1)
      return d
    }
  }
]
```

- [x] **Step 4: Create `src/core/triage/reminders.ts`.**

```ts
import { getDb } from '../store/db.js'
import { markDirtyByMessageId } from '../store/listRows.js'
import { LIST_COLS } from '../store/repo.js'
import type { MessageListRow } from '../store/types.js'

/**
 * Remind me, local only. A reminder is keyed by account + Message-ID; the list
 * read model hides its thread from the Inbox while pending (listRows.ts), and
 * nothing is ever moved on the server.
 */
export interface ReminderRow {
  id: number
  account_id: number
  message_id: string
  subject: string | null
  remind_at: number
  if_no_reply: number
  created_at: number
  fired_at: number | null
}

export function setReminder(input: {
  accountId: number
  messageId: string
  subject: string | null
  remindAt: number
  ifNoReply: boolean
  now?: number
}): void {
  getDb()
    .prepare(
      `INSERT INTO reminders (account_id, message_id, subject, remind_at, if_no_reply, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, message_id) DO UPDATE SET
         subject = excluded.subject, remind_at = excluded.remind_at,
         if_no_reply = excluded.if_no_reply, created_at = excluded.created_at, fired_at = NULL`
    )
    .run(
      input.accountId,
      input.messageId,
      input.subject,
      input.remindAt,
      input.ifNoReply ? 1 : 0,
      input.now ?? Date.now()
    )
  markDirtyByMessageId(input.accountId, input.messageId)
}

export function clearReminder(accountId: number, messageId: string): boolean {
  const n = getDb()
    .prepare('DELETE FROM reminders WHERE account_id = ? AND message_id = ?')
    .run(accountId, messageId).changes
  markDirtyByMessageId(accountId, messageId)
  return n > 0
}

/** A fired reminder has done its job once the thread is acted on (moved). */
export function dropFiredReminder(accountId: number, messageId: string): void {
  const n = getDb()
    .prepare('DELETE FROM reminders WHERE account_id = ? AND message_id = ? AND fired_at IS NOT NULL')
    .run(accountId, messageId).changes
  if (n) markDirtyByMessageId(accountId, messageId)
}

export type ReminderOutcome = 'wait' | 'fire' | 'drop'

/**
 * Any reply after the reminder was set ends it: for "if no reply" that is the
 * point, and a plain reminder's thread is already back in the Inbox.
 */
export function reminderOutcome(
  r: Pick<ReminderRow, 'remind_at' | 'created_at'>,
  lastReplyAt: number | null,
  now: number
): ReminderOutcome {
  if (lastReplyAt !== null && lastReplyAt > r.created_at) return 'drop'
  return now >= r.remind_at ? 'fire' : 'wait'
}

/** Newest message from someone else in the thread(s) holding `messageId`. */
export function lastReplyAt(accountId: number, messageId: string): number | null {
  const row = getDb()
    .prepare(
      `WITH th AS (
         SELECT DISTINCT COALESCE(thread_id, '#' || id) AS k FROM messages
          WHERE account_id = ? AND message_id = ?
       )
       SELECT MAX(m.date) AS d FROM messages m JOIN th
           ON (m.thread_id = th.k OR (m.thread_id IS NULL AND '#' || m.id = th.k))
         JOIN accounts a ON a.id = m.account_id
        WHERE m.account_id = ? AND m.folder_id IS NOT NULL
          AND lower(COALESCE(m.from_addr, '')) <> lower(a.email)`
    )
    .get(accountId, messageId, accountId) as { d: number | null }
  return row.d
}

/** Fires or drops every due reminder. Returns the ones that fired, for a notification. */
export function wakeDueReminders(now = Date.now()): { accountId: number; subject: string | null }[] {
  const db = getDb()
  const due = db
    .prepare('SELECT * FROM reminders WHERE fired_at IS NULL AND remind_at <= ?')
    .all(now) as ReminderRow[]
  const fired: { accountId: number; subject: string | null }[] = []
  for (const r of due) {
    const outcome = reminderOutcome(r, lastReplyAt(r.account_id, r.message_id), now)
    if (outcome === 'drop') db.prepare('DELETE FROM reminders WHERE id = ?').run(r.id)
    else if (outcome === 'fire') {
      db.prepare('UPDATE reminders SET fired_at = ? WHERE id = ?').run(now, r.id)
      fired.push({ accountId: r.account_id, subject: r.subject })
    }
    markDirtyByMessageId(r.account_id, r.message_id)
  }
  return fired
}

const M_COLS = LIST_COLS.split(', ')
  .map((c) => `m.${c}`)
  .join(', ')

/** The Reminders view: pending first by due time, then fired. Unsynced messages are skipped. */
export function listReminderRows(accountId: number): MessageListRow[] {
  return getDb()
    .prepare(
      `SELECT ${M_COLS}, r.remind_at AS remind_at,
              CASE WHEN r.fired_at IS NULL THEN 0 ELSE 1 END AS reminder_fired
         FROM reminders r
         JOIN messages m ON m.id = (
           SELECT x.id FROM messages x
            WHERE x.account_id = r.account_id AND x.message_id = r.message_id
            ORDER BY x.folder_id IS NULL, x.id LIMIT 1)
        WHERE r.account_id = ?
        ORDER BY r.fired_at IS NOT NULL, r.remind_at`
    )
    .all(accountId) as MessageListRow[]
}
```

- [x] **Step 5: Remind on send.**
  - `src/core/send/outbox.ts`: add `remind_at: number | null` to `OutboxRow`, `remind_at?: number | null` to `EnqueueOutboxInput`, `remind_at` to the INSERT columns, `@remind_at` to VALUES and `remind_at: input.remind_at ?? null` to the bound object.
  - `src/core/send/flush.ts`: `import { setReminder } from '../triage/reminders.js'`; right after `markOutboxSent(row.id)`:

```ts
    // "Remind me if no reply" was chosen in compose. Keyed by the Message-ID we
    // just sent, which is also what the Sent copy will carry once it syncs.
    if (row.remind_at) {
      try {
        setReminder({
          accountId: row.account_id,
          messageId: result.messageId || messageId,
          subject: row.subject,
          remindAt: row.remind_at,
          ifNoReply: true
        })
      } catch (err) {
        console.error('[outbox] reminder not saved:', err)
      }
    }
```

  - `electron/ipc.ts`: add `remindAt?: number | null` to `QueueSendPayload` and `remind_at: payload.remindAt ?? null` to the `enqueueOutbox` call. `electron/preload.ts`: add `remindAt?: number | null` to `QueueSendPayload`.

- [x] **Step 6: Drop a fired reminder when its thread moves.** In `electron/ipc.ts` `holdMove`, right before `for (const p of r.plan) moveMessage(...)`:

```ts
  // By thread: the reminder may sit on a message this move does not touch (the Sent copy).
  dropFiredReminders(r.plan.map((p) => p.id))
```

  with `import { dropFiredReminders } from '../src/core/triage/reminders.js'`. `dropFiredReminders(messageRowIds)` deletes every fired reminder on any message of those messages' threads (`COALESCE(thread_id, '#' || id)`) and marks those threads dirty; keying by the moved message alone missed remind-on-send, whose reminder is on the Sent copy an Inbox Done never moves.

  Review fix (reschedule undo): `setReminder` returns the reminder it replaced (`ReminderSnapshot | null`). `reminders:set` returns `{ set, fresh, prev, holdMs }`: `prev` holds the replaced reminders as they were, `fresh` the row ids that had none. Undo calls `reminders:restore(prev)` (`restoreReminders`, an exact upsert including `fired_at`) and `reminders:clear(fresh)`. `remindSelected` drops rows optimistically only in the Inbox (the only place a pending reminder hides anything); elsewhere, the Reminders view included, it re-reads the page.

- [x] **Step 7: IPC and the wake worker.**
  - `electron/ipcTriage.ts`, imports: `setReminder, clearReminder, listReminderRows` from `../src/core/triage/reminders.js`, `getMessage, groupByAccount` from repo, `getSettings` from repo, `undoWindowMs` from `../src/core/triage/undoWindow.js`. Inside `registerTriageIpc()`:

```ts
  // Row ids act on their owning account, not the active one.
  ipcMain.handle('reminders:set', (_e, ids: number[], remindAt: number, ifNoReply: boolean) => {
    const set: number[] = []
    for (const id of ids) {
      const m = getMessage(id)
      if (!m?.message_id) continue
      setReminder({ accountId: m.account_id, messageId: m.message_id, subject: m.subject, remindAt, ifNoReply })
      set.push(id)
    }
    return { ok: true as const, set, holdMs: undoWindowMs(getSettings()) }
  })

  ipcMain.handle('reminders:clear', (_e, ids: number[]) => {
    for (const id of ids) {
      const m = getMessage(id)
      if (m?.message_id) clearReminder(m.account_id, m.message_id)
    }
    return { ok: true as const }
  })

  ipcMain.handle('reminders:list', () => {
    const s = getBootState()
    return s.ok ? listReminderRows(s.accountId) : []
  })
```

    (drop `groupByAccount` from the import if unused).
  - Create `electron/reminderWorker.ts`:

```ts
import { BrowserWindow, Notification } from 'electron'
import { wakeDueReminders } from '../src/core/triage/reminders.js'

let timer: ReturnType<typeof setInterval> | null = null

/** Reminders fire only while the app runs (the spec's no-server rule), checked every 30s. */
export function startReminderWorker(intervalMs = 30_000): void {
  if (timer) return
  const tick = (): void => {
    try {
      const fired = wakeDueReminders()
      if (!fired.length) return
      for (const w of BrowserWindow.getAllWindows())
        w.webContents.send('reminders:fired', { count: fired.length })
      if (Notification.isSupported()) {
        for (const f of fired.slice(0, 3))
          new Notification({ title: 'Reminder', body: f.subject || '(no subject)' }).show()
      }
    } catch (e) {
      console.error('[reminders] wake failed:', e)
    }
  }
  tick()
  timer = setInterval(tick, intervalMs)
}
```

  - `electron/main.ts`: import it and call `startReminderWorker()` after `startOutboxWorker(...)`.
  - `electron/preload.ts`:

```ts
  setReminder: (
    ids: number[],
    remindAt: number,
    ifNoReply: boolean
  ): Promise<{ ok: true; set: number[]; holdMs: number }> =>
    ipcRenderer.invoke('reminders:set', ids, remindAt, ifNoReply),
  clearReminders: (ids: number[]): Promise<{ ok: true }> => ipcRenderer.invoke('reminders:clear', ids),
  listReminders: (): Promise<MessageListRow[]> => ipcRenderer.invoke('reminders:list'),
  onRemindersFired: (cb: (p: { count: number }) => void): (() => void) => {
    const h = (_e: unknown, p: { count: number }): void => cb(p)
    ipcRenderer.on('reminders:fired', h)
    return () => ipcRenderer.off('reminders:fired', h)
  },
```

- [x] **Step 8: Create `src/ui/views/RemindPicker.tsx`.**

```tsx
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { parseWhen, PRESETS } from '../when'

interface Props {
  title?: string
  /** Compose turns this on: a reminder on your own mail is about the reply. */
  defaultIfNoReply?: boolean
  onPick: (at: number, ifNoReply: boolean) => void
  /** Shown when the target already has a reminder. */
  onClear?: () => void
  onClose: () => void
}

const fmt = (d: Date): string =>
  d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function RemindPicker({ title = 'Remind me', defaultIfNoReply = false, onPick, onClear, onClose }: Props) {
  const [text, setText] = useState('')
  const [active, setActive] = useState(0)
  const [ifNoReply, setIfNoReply] = useState(defaultIfNoReply)
  const inputRef = useRef<HTMLInputElement>(null)
  const parsed = useMemo(() => parseWhen(text, new Date()), [text])

  useEffect(() => inputRef.current?.focus(), [])

  const submit = (at: Date | null): void => {
    if (at && at.getTime() > Date.now()) onPick(at.getTime(), ifNoReply)
  }

  // Keys are local to the picker, like the command palette's.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(PRESETS.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      submit(text.trim() ? parsed : PRESETS[active].at(new Date()))
    }
  }

  return (
    <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="picker" onKeyDown={onKey}>
        <div className="picker-title">{title}</div>
        <input ref={inputRef} className="picker-input" placeholder="tomorrow 9am, fri, in 3 days…"
          value={text} onChange={(e) => setText(e.target.value)} />
        <div className="picker-hint">
          {text.trim() ? (parsed ? fmt(parsed) : 'Not a time I understand') : '↑↓ to choose, ↵ to set'}
        </div>
        <ul className="picker-list">
          {PRESETS.map((p, i) => (
            <li key={p.id}>
              <button type="button" data-active={!text.trim() && i === active} onClick={() => submit(p.at(new Date()))}>
                <span>{p.label}</span>
                <span className="picker-meta">{fmt(p.at(new Date()))}</span>
              </button>
            </li>
          ))}
        </ul>
        <label className="picker-check">
          <input type="checkbox" checked={ifNoReply} onChange={(e) => setIfNoReply(e.target.checked)} />
          Only if nobody replies
        </label>
        {onClear && (
          <button type="button" className="picker-clear" onClick={onClear}>Remove reminder</button>
        )}
      </div>
    </div>
  )
}
```

- [x] **Step 9: Commands.** Add `'msg.remind' | 'go.reminders' | 'compose.remind'` to `CommandId` and to `COMMANDS`:

```ts
  { id: 'go.reminders', title: 'Go to Reminders', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 'h'], modes: ['list'] }] },
  { id: 'msg.remind', title: 'Remind me', group: 'Message', palette: true, keys: [{ kind: 'key', key: 'h', modes: LIST_THREAD }] },
  { id: 'compose.remind', title: 'Remind me if no reply', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'h', shift: true, modes: ['compose'] }] },
```

- [x] **Step 10: The Reminders view in the UI.**
  - `src/ui/store.ts`: `export const REMINDERS_VIEW_ID = -1` with the doc `/** activeFolderId sentinel for the Reminders view, which is not an IMAP folder. */`.
  - `src/ui/views/Sidebar.tsx`: import `Clock` and `REMINDERS_VIEW_ID`; add a Reminders button in `.sidebar-tasks` above Tasks, built exactly like the Tasks button, with `aria-current={activeFolderId === REMINDERS_VIEW_ID}`, the `Clock` icon, label "Reminders" and `onClick` calling `onSelect(REMINDERS_VIEW_ID)`.
  - `src/ui/views/MessageList.tsx`: import `Clock` from `lucide-react`; in `.row-trailing`, before the flag, render `{r.reminder_fired ? <Clock className="row-reminder" size={12} strokeWidth={2} aria-label="Reminder" /> : null}`; and show `formatDate(r.remind_at ?? r.date)` in `.row-date`.

- [x] **Step 11: App wiring** (`src/ui/App.tsx`):
  - Import `RemindPicker` and `REMINDERS_VIEW_ID`.
  - Overlay state (later tasks extend the union):

```ts
  type Overlay = { kind: 'remind'; fromThread: boolean; hasReminder: boolean }
  const [overlay, setOverlay] = useState<Overlay | null>(null)
```

    (declare the `type` at module level, above `export default function App`).
  - `mode`: change the first condition to `paletteOpen || settingsOpen || shortcutsOpen || overlay ? 'modal'`.
  - `fetchPage`: first line `if (folderId === REMINDERS_VIEW_ID) return page === 0 ? window.api.listReminders() : []`.
  - `loadRows`: `setTotalRows(folderId === REMINDERS_VIEW_ID ? rows.length : await window.api.countMessages(folderId, currentQuery(folderId)))`. In `goToPage`, skip `loadOlder` when `folderId === REMINDERS_VIEW_ID`.
  - List header title: `{activeFolderId === REMINDERS_VIEW_ID ? 'Reminders' : active ? folderLabel(active) : 'Supermail'}`; hide the `SplitBar` in that view (the `active &&` guard already does, since no folder matches -1).
  - Refresh on fire, inside the effect that subscribes `onNewMail`:

```ts
    const offReminders = window.api.onRemindersFired(() => {
      const id = useStore.getState().activeFolderId
      if (id) void loadRows(id, true)
    })
```

    and call `offReminders()` in its cleanup.
  - Handlers:

```ts
  const remindSelected = useCallback(
    async (at: number, ifNoReply: boolean) => {
      const ids = targetIds()
      if (!ids.length) return
      const res = await window.api.setReminder(ids, at, ifNoReply)
      const removed = removeRows(res.set)
      clearChecked()
      const when = new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
      pushUndo(`Reminder set for ${when}`, res.holdMs, async () => {
        await window.api.clearReminders(res.set)
        restoreRows(removed)
      })
    },
    [targetIds, removeRows, clearChecked, pushUndo, restoreRows]
  )

  const onRemindPick = useCallback(
    (at: number, ifNoReply: boolean) => {
      const o = overlay
      setOverlay(null)
      if (o?.fromThread) void triageFromThread(() => remindSelected(at, ifNoReply))
      else void remindSelected(at, ifNoReply)
    },
    [overlay, triageFromThread, remindSelected]
  )
```

    and in `handlers`:

```ts
        'msg.remind': ({ mode: m }) =>
          setOverlay({
            kind: 'remind',
            fromThread: m === 'thread',
            hasReminder: useStore.getState().activeFolderId === REMINDERS_VIEW_ID
          }),
        'go.reminders': () => void onFolder(REMINDERS_VIEW_ID),
```

  - Render, next to `<CommandPalette>`:

```tsx
      {overlay?.kind === 'remind' && (
        <RemindPicker
          onPick={onRemindPick}
          onClose={() => setOverlay(null)}
          onClear={
            overlay.hasReminder
              ? async () => {
                  setOverlay(null)
                  await window.api.clearReminders(targetIds())
                  void refreshRows()
                }
              : undefined
          }
        />
      )}
```

- [x] **Step 12: Compose `⌘⇧H`.** In `src/ui/store.ts` add `remindAt: number | null` to `ComposeState` and `remindAt: null` to `emptyCompose()`. In `src/ui/views/Compose.tsx`:
  - `import { RemindPicker } from './RemindPicker'`; `const [reminding, setReminding] = useState(false)`.
  - Add to the `chords` array: `{ key: 'h', shift: true, handler: () => setReminding(true) }` (it is declared in `commands.ts` as `compose.remind`).
  - The Escape listener's condition becomes `e.key === 'Escape' && !showSchedule && !reminding` (add `reminding` to its deps).
  - Pass `remindAt: compose.remindAt` in the `queueSend` payload.
  - Under the header (above `compose-error`):

```tsx
      {compose.remindAt && (
        <div className="compose-remind">
          Remind me if no reply · {new Date(compose.remindAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          <button type="button" aria-label="Remove reminder" onClick={() => updateCompose({ remindAt: null })}>×</button>
        </div>
      )}
      {reminding && (
        <RemindPicker
          title="Remind me if no reply"
          defaultIfNoReply
          onPick={(at) => {
            setReminding(false)
            updateCompose({ remindAt: at })
          }}
          onClose={() => setReminding(false)}
        />
      )}
```

    A compose reminder is always "if no reply" (main sets `ifNoReply: true` on send), so the picker's checkbox only matters for `h`.

- [x] **Step 13: Styles.** `.picker` (a centred card like `.settings`, ~360px wide, `padding: var(--space-4)`, `background: var(--bg-raised)`, `border-radius: var(--radius-md)`, `box-shadow: var(--shadow-md)`), `.picker-title` (`font-size: var(--text-sm)`, `color: var(--text-secondary)`), `.picker-input` (full width, border and radius like `.settings-signature`), `.picker-hint` and `.picker-meta` (`font-size: var(--text-xs)`, `color: var(--text-tertiary)`), `.picker-list button` (flex row, space-between, full width, `padding: var(--space-2)`; `[data-active='true']` and `:hover` get `background: var(--surface-hover)`), `.picker-check`, `.picker-clear`, `.row-reminder` (`color: var(--accent)`), `.compose-remind` (a one-line bar in `var(--text-sm)` with `var(--surface-selected)` background).

- [x] **Step 14: Run everything.** `pnpm typecheck && pnpm test`: green (2 more files). In `pnpm dev`: `h` on a row → "in 2 min" → the row disappears and `z` brings it back; set it again, wait: within 30 s of due time a notification shows and the thread is at the top of Inbox with a clock; `g h` lists reminders; in compose `⌘⇧H` adds the pill and, after sending, the reminder appears in `g h`.

- [ ] **Step 15: Commit.**

```bash
git add src/core/triage/reminders.ts src/core/triage/reminders.test.ts src/core/send src/ui/when.ts src/ui/when.test.ts src/ui/views/RemindPicker.tsx src/ui/views/Compose.tsx src/ui/views/Sidebar.tsx src/ui/views/MessageList.tsx src/ui/store.ts src/ui/commands.ts src/ui/App.tsx src/ui/styles/app.css electron/reminderWorker.ts electron/ipcTriage.ts electron/ipc.ts electron/main.ts electron/preload.ts
git commit -m "[feat] remind me: local reminders, natural-language times, remind on send"
```

---

### Task 9: Mute, Move / Label, and VIP senders

**Files:**
- Create: `src/core/triage/localRules.ts`, `src/core/triage/localRules.test.ts`, `src/ui/views/Picker.tsx`
- Modify: `electron/ipc.ts`, `electron/ipcTriage.ts`, `electron/preload.ts`, `src/ui/commands.ts`, `src/ui/App.tsx`

- [x] **Step 1: Write the failing test.**

```ts
// src/core/triage/localRules.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { listView } from '../store/listRows.js'
import { upsertMessage } from '../store/repo.js'
import { toggleMute, toggleVip } from './localRules.js'

let uid = 0
const put = (folder: number, thread: string, from = 'x@y.test') =>
  upsertMessage({
    account_id: 1, folder_id: folder, uid: ++uid, message_id: `<${uid}@t>`, thread_id: thread,
    in_reply_to: null, from_addr: from, from_name: null, to_addrs: '[]', cc_addrs: '[]',
    subject: thread, date: uid, snippet: null, flags: '[]'
  })

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'rules-')), 't.db'))
  uid = 0
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
  getDb().prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox'),(2,1,'Archive','archive')").run()
})

describe('mute', () => {
  it('keeps the thread, and new replies to it, out of the Inbox only', () => {
    const a = put(1, 'a')
    put(1, 'b')
    put(2, 'a')
    expect(toggleMute(a)).toBe(true)
    put(1, 'a') // a new reply
    expect(listView(1).map((r) => r.subject)).toEqual(['b'])
    expect(listView(2).map((r) => r.subject)).toEqual(['a'])
    expect(toggleMute(a)).toBe(false)
    expect(listView(1).map((r) => r.subject)).toEqual(['a', 'b'])
  })

  it('cannot mute a message without a Message-ID', () => {
    const id = Number(
      getDb().prepare("INSERT INTO messages (account_id,folder_id,uid,thread_id) VALUES (1,1,999,'z')").run()
        .lastInsertRowid
    )
    expect(toggleMute(id)).toBeNull()
  })
})

describe('VIP', () => {
  it('toggles the sender of a message', () => {
    const a = put(1, 'a', 'Boss@X.test')
    expect(toggleVip(a)).toBe(true)
    expect(getDb().prepare('SELECT address FROM vip_senders').all()).toEqual([{ address: 'boss@x.test' }])
    expect(listView(1, { query: 'is:vip' })).toHaveLength(1)
    expect(toggleVip(a)).toBe(false)
  })
})
```

- [x] **Step 2: Run it and confirm it fails.** `pnpm exec vitest run src/core/triage/localRules.test.ts`. Expected: FAIL.

- [x] **Step 3: Create `src/core/triage/localRules.ts`.**

```ts
import { getDb } from '../store/db.js'
import { markDirtyByMessageId } from '../store/listRows.js'
import { getMessage } from '../store/repo.js'

/** Message-IDs of every message in `rowId`'s thread, for its account. */
function threadMessageIds(rowId: number): { accountId: number; ids: string[] } | null {
  const m = getMessage(rowId)
  if (!m) return null
  const rows = m.thread_id
    ? (getDb()
        .prepare(
          'SELECT DISTINCT message_id FROM messages WHERE account_id = ? AND thread_id = ? AND message_id IS NOT NULL'
        )
        .all(m.account_id, m.thread_id) as { message_id: string }[])
    : m.message_id
      ? [{ message_id: m.message_id }]
      : []
  return { accountId: m.account_id, ids: rows.map((r) => r.message_id) }
}

/**
 * Mute is a local rule: the thread, and any reply that arrives later, stays
 * out of the local Inbox (listRows hides it). Nothing moves on the server.
 * Returns the new state, or null when nothing in the thread has a Message-ID.
 */
export function toggleMute(rowId: number, now = Date.now()): boolean | null {
  const t = threadMessageIds(rowId)
  if (!t?.ids.length) return null
  const db = getDb()
  const holes = t.ids.map(() => '?').join(',')
  const muted = !!db
    .prepare(`SELECT 1 FROM mutes WHERE account_id = ? AND message_id IN (${holes}) LIMIT 1`)
    .get(t.accountId, ...t.ids)
  db.transaction(() => {
    if (muted) {
      db.prepare(`DELETE FROM mutes WHERE account_id = ? AND message_id IN (${holes})`).run(t.accountId, ...t.ids)
    } else {
      const own = getMessage(rowId)?.message_id ?? t.ids[0]
      db.prepare('INSERT OR IGNORE INTO mutes (account_id, message_id, created_at) VALUES (?, ?, ?)').run(
        t.accountId,
        own,
        now
      )
    }
    for (const id of t.ids) markDirtyByMessageId(t.accountId, id)
  })()
  return !muted
}

/** Marks the sender VIP (always Important, and the VIP split), or unmarks them. */
export function toggleVip(rowId: number): boolean | null {
  const m = getMessage(rowId)
  const address = m?.from_addr?.trim().toLowerCase()
  if (!m || !address) return null
  const db = getDb()
  const had = db
    .prepare('DELETE FROM vip_senders WHERE account_id = ? AND address = ?')
    .run(m.account_id, address).changes > 0
  if (!had) db.prepare('INSERT INTO vip_senders (account_id, address) VALUES (?, ?)').run(m.account_id, address)
  return !had
}
```

- [x] **Step 4: IPC.**
  - `electron/ipc.ts`: export `flagWriterFor` (`export function flagWriterFor(...)`).
  - `electron/ipcTriage.ts`, imports: `toggleMute, toggleVip` from `../src/core/triage/localRules.js`; `addMessageLabel, gmailLabelChoices, labelsForMessages, removeMessageLabel` from `../src/core/store/labels.js`; `listFolders, threadMatesInFolder` from repo; `getAccount` from `./state.js`; `flagWriterFor` from `./ipc.js`. Inside `registerTriageIpc()`:

```ts
  ipcMain.handle('triage:mute', (_e, rowId: number) => {
    const muted = toggleMute(rowId)
    return muted === null
      ? { ok: false as const, error: 'This message cannot be muted' }
      : { ok: true as const, muted, holdMs: undoWindowMs(getSettings()) }
  })

  ipcMain.handle('triage:vip', (_e, rowId: number) => {
    const vip = toggleVip(rowId)
    return vip === null ? { ok: false as const, error: 'No sender' } : { ok: true as const, vip }
  })

  ipcMain.handle('labels:choices', () => {
    const s = getBootState()
    return s.ok && s.config.provider === 'gmail' ? gmailLabelChoices(listFolders(s.accountId)) : []
  })

  ipcMain.handle('labels:forMessages', (_e, ids: number[]) => labelsForMessages(ids))

  // Optimistic like flags: SQLite now, STORE ±X-GM-LABELS in the background.
  ipcMain.handle('messages:label', (_e, ids: number[], label: string, add: boolean) => {
    for (const [accountId, own] of groupByAccount(ids)) {
      const acct = getAccount(accountId)
      if (!acct) continue
      if (acct.config.provider !== 'gmail') return { ok: false as const, error: 'Labels are Gmail only' }
      const writer = flagWriterFor(accountId, acct.config)
      for (const rowId of own) {
        for (const id of threadMatesInFolder(rowId)) {
          const changed = add ? addMessageLabel(id, accountId, label) : removeMessageLabel(id, accountId, label)
          if (changed) writer.enqueue({ messageId: id, flag: label, add, useLabels: true })
        }
      }
    }
    return { ok: true as const }
  })
```

  - `electron/preload.ts`:

```ts
  toggleMute: (
    rowId: number
  ): Promise<{ ok: true; muted: boolean; holdMs: number } | { ok: false; error: string }> =>
    ipcRenderer.invoke('triage:mute', rowId),
  toggleVip: (rowId: number): Promise<{ ok: true; vip: boolean } | { ok: false; error: string }> =>
    ipcRenderer.invoke('triage:vip', rowId),
  labelChoices: (): Promise<string[]> => ipcRenderer.invoke('labels:choices'),
  labelsFor: (ids: number[]): Promise<Record<number, string[]>> =>
    ipcRenderer.invoke('labels:forMessages', ids),
  setLabel: (
    ids: number[],
    label: string,
    add: boolean
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('messages:label', ids, label, add),
```

- [x] **Step 5: Create `src/ui/views/Picker.tsx`** (shared by Move and Label):

```tsx
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

export interface PickerItem {
  id: string
  label: string
  /** Label picker: shows a check; Enter toggles instead of closing. */
  checked?: boolean
}

interface Props {
  title: string
  items: PickerItem[]
  onPick: (id: string) => void
  onClose: () => void
  emptyText?: string
}

export function Picker({ title, items, onPick, onClose, emptyText = 'Nothing to pick' }: Props) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const shown = useMemo(
    () => items.filter((i) => i.label.toLowerCase().includes(q.trim().toLowerCase())),
    [items, q]
  )
  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => setActive(0), [q])

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(shown.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter' && shown[active]) {
      e.preventDefault()
      onPick(shown[active].id)
    }
  }

  return (
    <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="picker" onKeyDown={onKey}>
        <div className="picker-title">{title}</div>
        <input ref={inputRef} className="picker-input" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="picker-list">
          {shown.length === 0 && <li className="picker-hint">{emptyText}</li>}
          {shown.map((it, i) => (
            <li key={it.id}>
              <button type="button" data-active={i === active} onClick={() => onPick(it.id)}>
                <span>{it.label}</span>
                {it.checked !== undefined && <span className="picker-meta">{it.checked ? '✓' : ''}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
```

- [x] **Step 6: Commands.** Add `'msg.mute' | 'msg.move' | 'msg.label' | 'msg.vip'` to `CommandId` and to `COMMANDS` (Message group):

```ts
  { id: 'msg.move', title: 'Move to folder…', group: 'Message', palette: true, keys: [{ kind: 'key', key: 'v', modes: LIST_THREAD }] },
  { id: 'msg.label', title: 'Label… (Gmail)', group: 'Message', palette: true, keys: [{ kind: 'key', key: 'l', modes: LIST_THREAD }] },
  { id: 'msg.mute', title: 'Mute conversation', group: 'Message', palette: true, keys: [{ kind: 'key', key: 'M', modes: LIST_THREAD }] },
  { id: 'msg.vip', title: 'Toggle VIP sender', group: 'Message', palette: true, keys: [] },
```

- [x] **Step 7: App wiring** (`src/ui/App.tsx`):
  - Import `Picker, type PickerItem`.
  - Extend the overlay union:

```ts
type Overlay =
  | { kind: 'remind'; fromThread: boolean; hasReminder: boolean }
  | { kind: 'move'; fromThread: boolean }
  | { kind: 'label'; ids: number[]; items: PickerItem[] }
```

  - A helper for "the row the action is about", used here and in Task 10:

```ts
  /** The open thread's message, or the checked rows / cursor row in the list. */
  const actionIds = useCallback((): number[] => {
    const ot = useStore.getState().openThread
    return ot ? [ot.messageId] : targetIds()
  }, [targetIds])
```

  - Handlers:

```ts
  const muteSelected = useCallback(async () => {
    const [id] = actionIds()
    if (!id) return
    const res = await window.api.toggleMute(id)
    if (!res.ok) return setSyncError(res.error)
    if (useStore.getState().openThread) closeThread()
    await refreshRows()
    pushUndo(res.muted ? 'Muted' : 'Unmuted', res.holdMs, async () => {
      await window.api.toggleMute(id)
      await refreshRows()
    })
  }, [actionIds, setSyncError, closeThread, refreshRows, pushUndo])

  const openLabelPicker = useCallback(async () => {
    const ids = actionIds()
    if (!ids.length) return
    const choices = await window.api.labelChoices()
    if (!choices.length) return setSyncError('Labels are Gmail only')
    const current = new Set(Object.values(await window.api.labelsFor(ids)).flat())
    setOverlay({ kind: 'label', ids, items: choices.map((c) => ({ id: c, label: c, checked: current.has(c) })) })
  }, [actionIds, setSyncError])
```

    and in `handlers`:

```ts
        'msg.move': ({ mode: m }) => setOverlay({ kind: 'move', fromThread: m === 'thread' }),
        'msg.label': () => openLabelPicker(),
        'msg.mute': () => muteSelected(),
        'msg.vip': async () => {
          const [id] = actionIds()
          if (!id) return
          const r = await window.api.toggleVip(id)
          if (!r.ok) setSyncError(r.error)
        },
```

  - Render with the other overlays:

```tsx
      {overlay?.kind === 'move' && (
        <Picker
          title="Move to"
          items={folders
            .filter((f) => f.id !== activeFolderId && f.role !== 'drafts')
            .map((f) => ({ id: String(f.id), label: folderLabel(f) }))}
          onClose={() => setOverlay(null)}
          onPick={(id) => {
            const fromThread = overlay.fromThread
            setOverlay(null)
            const move = () => moveSelected({ folderId: Number(id) }, 'Moved')
            void (fromThread ? triageFromThread(move) : move())
          }}
        />
      )}
      {overlay?.kind === 'label' && (
        <Picker
          title="Label"
          items={overlay.items}
          onClose={() => setOverlay(null)}
          onPick={async (label) => {
            const item = overlay.items.find((i) => i.id === label)
            const add = !item?.checked
            const r = await window.api.setLabel(overlay.ids, label, add)
            if (!r.ok) return setSyncError(r.error)
            setOverlay({
              ...overlay,
              items: overlay.items.map((i) => (i.id === label ? { ...i, checked: add } : i))
            })
          }}
        />
      )}
```

- [x] **Step 8: Run everything.** `pnpm typecheck && pnpm test`: green (1 more file). In `pnpm dev`: `M` hides a thread from Inbox and `z` unmutes; `v` moves to a chosen folder with undo; on Gmail `l` lists labels, toggling one shows up in Gmail web within a few seconds; on Exmail `l` says "Labels are Gmail only"; "Toggle VIP sender" from ⌘K moves that sender into the VIP split.

- [ ] **Step 9: Commit.**

```bash
git add src/core/triage/localRules.ts src/core/triage/localRules.test.ts src/ui/views/Picker.tsx src/ui/commands.ts src/ui/App.tsx electron/ipc.ts electron/ipcTriage.ts electron/preload.ts
git commit -m "[feat] mute, move, gmail labels and vip senders"
```

---

### Task 10: Unsubscribe, Get me to zero, and the inbox-zero state

**Files:**
- Create: `src/core/triage/unsubscribe.ts`, `src/core/triage/unsubscribe.test.ts`, `src/core/triage/zero.ts`, `src/core/triage/zero.test.ts`, `src/ui/streak.ts`, `src/ui/streak.test.ts`, `src/ui/views/ConfirmDialog.tsx`, `src/ui/views/ZeroModal.tsx`, `src/ui/views/ZeroState.tsx`
- Modify: `electron/ipcTriage.ts`, `electron/preload.ts`, `src/ui/commands.ts`, `src/ui/commands.test.ts`, `src/ui/App.tsx`, `src/ui/views/MessageList.tsx`, `src/ui/styles/app.css`

- [x] **Step 1: Write the failing tests.**

```ts
// src/core/triage/unsubscribe.test.ts
import { describe, expect, it, vi } from 'vitest'
import { parseListUnsubscribe, parseMailto, planUnsubscribe, runUnsubscribe } from './unsubscribe.js'

describe('List-Unsubscribe parsing', () => {
  it('splits web and mailto targets, in header order', () => {
    expect(
      parseListUnsubscribe('<mailto:u@l.test?subject=stop>, <https://l.test/u?id=1>, <http://l.test/old>')
    ).toEqual({ web: ['https://l.test/u?id=1', 'http://l.test/old'], mailto: ['mailto:u@l.test?subject=stop'] })
    expect(parseListUnsubscribe(null)).toEqual({ web: [], mailto: [] })
    expect(parseListUnsubscribe('no brackets here')).toEqual({ web: [], mailto: [] })
  })

  it('reads a mailto address, subject and body', () => {
    expect(parseMailto('mailto:u@l.test?subject=stop&body=please')).toEqual({ to: 'u@l.test', subject: 'stop', body: 'please' })
    expect(parseMailto('mailto:u@l.test')).toEqual({ to: 'u@l.test', subject: 'unsubscribe', body: 'unsubscribe' })
    expect(parseMailto('mailto:not-an-address')).toBeNull()
  })
})

describe('planUnsubscribe', () => {
  const header = '<mailto:u@l.test>, <https://l.test/u>'
  it('prefers an RFC 8058 one-click POST', () => {
    expect(planUnsubscribe(header, true)).toEqual({ method: 'post', url: 'https://l.test/u', host: 'l.test' })
  })
  it('falls back to mail, then to the browser', () => {
    expect(planUnsubscribe(header, false)).toEqual({ method: 'mailto', to: 'u@l.test', subject: 'unsubscribe', body: 'unsubscribe' })
    expect(planUnsubscribe('<https://l.test/u>', false)).toEqual({ method: 'browser', url: 'https://l.test/u', host: 'l.test' })
  })
  it('never POSTs over plain http', () => {
    expect(planUnsubscribe('<http://l.test/u>', true)).toEqual({ method: 'browser', url: 'http://l.test/u', host: 'l.test' })
  })
  it('has nothing for a message without the header', () => {
    expect(planUnsubscribe(null, false)).toBeNull()
  })
})

describe('runUnsubscribe', () => {
  const deps = () => ({
    post: vi.fn(async (_url: string) => true),
    sendMail: vi.fn((_to: string, _subject: string, _body: string) => {}),
    openUrl: vi.fn(async (_url: string) => {})
  })
  it('runs the chosen method only', async () => {
    const d = deps()
    expect(await runUnsubscribe({ method: 'post', url: 'https://l.test/u', host: 'l.test' }, d)).toEqual({ ok: true })
    expect(d.post).toHaveBeenCalledWith('https://l.test/u')
    expect(d.sendMail).not.toHaveBeenCalled()
  })
  it('reports a refused POST', async () => {
    const d = { ...deps(), post: vi.fn(async (_url: string) => false) }
    expect(await runUnsubscribe({ method: 'post', url: 'https://l.test/u', host: 'l.test' }, d)).toEqual({
      ok: false,
      error: 'l.test did not accept the request'
    })
  })
})
```

```ts
// src/core/triage/zero.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { upsertMessage } from '../store/repo.js'
import { zeroCandidates } from './zero.js'

const DAY = 86_400_000
const NOW = 100 * DAY
let uid = 0
const put = (thread: string, ageDays: number, flags: string[]) =>
  upsertMessage({
    account_id: 1, folder_id: 1, uid: ++uid, message_id: `<${uid}@t>`, thread_id: thread,
    in_reply_to: null, from_addr: 'x@y.test', from_name: null, to_addrs: '[]', cc_addrs: '[]',
    subject: thread, date: NOW - ageDays * DAY, snippet: null, flags: JSON.stringify(flags)
  })

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'zero-')), 't.db'))
  uid = 0
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
  getDb().prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox')").run()
})

describe('zeroCandidates', () => {
  it('picks conversations older than N days, optionally keeping unread and starred ones', () => {
    const old = put('old', 10, ['\\Seen'])
    const unread = put('unread', 10, [])
    const starred = put('starred', 10, ['\\Seen', '\\Flagged'])
    put('new', 1, ['\\Seen'])
    const keepBoth = { olderThanDays: 7, keepUnread: true, keepStarred: true }
    expect(zeroCandidates(1, keepBoth, NOW)).toEqual([old])
    expect(zeroCandidates(1, { ...keepBoth, keepUnread: false, keepStarred: false }, NOW).sort()).toEqual(
      [old, unread, starred].sort()
    )
  })
})
```

```ts
// src/ui/streak.test.ts
import { describe, expect, it } from 'vitest'
import { dayKey, nextStreak } from './streak.js'

describe('inbox-zero streak', () => {
  it('formats local days', () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
  it('counts consecutive days and restarts after a gap', () => {
    expect(nextStreak({ days: 0, lastDay: null }, '2026-10-29')).toEqual({ days: 1, lastDay: '2026-10-29' })
    expect(nextStreak({ days: 1, lastDay: '2026-10-29' }, '2026-10-29')).toEqual({ days: 1, lastDay: '2026-10-29' })
    expect(nextStreak({ days: 4, lastDay: '2026-10-31' }, '2026-11-01')).toEqual({ days: 5, lastDay: '2026-11-01' })
    expect(nextStreak({ days: 4, lastDay: '2026-10-28' }, '2026-10-30')).toEqual({ days: 1, lastDay: '2026-10-30' })
  })
})
```

  Append to `src/ui/commands.test.ts` inside `describe('command registry', ...)`:

```ts
  it('keeps ⌘U for Unsubscribe in the list and for Underline in compose', () => {
    const h = { 'msg.unsubscribe': () => {} }
    expect(buildChords('list', h).map((c) => c.key)).toEqual(['u'])
    expect(buildChords('compose', h)).toEqual([])
  })
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/core/triage/unsubscribe.test.ts src/core/triage/zero.test.ts src/ui/streak.test.ts src/ui/commands.test.ts`. Expected: FAIL.

- [x] **Step 3: Create `src/core/triage/unsubscribe.ts`.**

```ts
export interface UnsubscribeTargets {
  /** http(s) URLs, in header order. Only https may be POSTed (RFC 8058). */
  web: string[]
  mailto: string[]
}

export function parseListUnsubscribe(header: string | null): UnsubscribeTargets {
  const out: UnsubscribeTargets = { web: [], mailto: [] }
  if (!header) return out
  for (const m of header.matchAll(/<([^>]+)>/g)) {
    const u = m[1].trim()
    if (/^https?:\/\//i.test(u)) out.web.push(u)
    else if (/^mailto:/i.test(u)) out.mailto.push(u)
  }
  return out
}

export function parseMailto(uri: string): { to: string; subject: string; body: string } | null {
  try {
    const u = new URL(uri)
    const to = decodeURIComponent(u.pathname)
    if (!/^[^@\s]+@[^@\s]+$/.test(to)) return null
    return {
      to,
      subject: u.searchParams.get('subject') || 'unsubscribe',
      body: u.searchParams.get('body') || 'unsubscribe'
    }
  } catch {
    return null
  }
}

export type UnsubscribePlan =
  | { method: 'post'; url: string; host: string }
  | { method: 'mailto'; to: string; subject: string; body: string }
  | { method: 'browser'; url: string; host: string }

/** One-click POST when offered over https, else an email, else the sender's page. */
export function planUnsubscribe(header: string | null, oneClick: boolean): UnsubscribePlan | null {
  const t = parseListUnsubscribe(header)
  const https = t.web.find((u) => /^https:\/\//i.test(u))
  if (oneClick && https) return { method: 'post', url: https, host: new URL(https).host }
  for (const m of t.mailto) {
    const mt = parseMailto(m)
    if (mt) return { method: 'mailto', ...mt }
  }
  const web = https ?? t.web[0]
  return web ? { method: 'browser', url: web, host: new URL(web).host } : null
}

/** What the confirm dialog says will happen. */
export function describePlan(plan: UnsubscribePlan): string {
  if (plan.method === 'post') return `Supermail will send an unsubscribe request to ${plan.host}.`
  if (plan.method === 'mailto') return `Supermail will send an unsubscribe email to ${plan.to}.`
  return `This opens ${plan.host} in your browser to finish unsubscribing.`
}

export interface UnsubscribeDeps {
  post: (url: string) => Promise<boolean>
  sendMail: (to: string, subject: string, body: string) => void
  openUrl: (url: string) => Promise<void>
}

export async function runUnsubscribe(
  plan: UnsubscribePlan,
  deps: UnsubscribeDeps
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (plan.method === 'post') {
      return (await deps.post(plan.url))
        ? { ok: true }
        : { ok: false, error: `${plan.host} did not accept the request` }
    }
    if (plan.method === 'mailto') deps.sendMail(plan.to, plan.subject, plan.body)
    else await deps.openUrl(plan.url)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
```

- [x] **Step 4: Create `src/core/triage/zero.ts`.**

```ts
import { getDb } from '../store/db.js'
import { refreshListRows } from '../store/listRows.js'

export interface ZeroOptions {
  olderThanDays: number
  keepUnread: boolean
  keepStarred: boolean
}

/** Newest-message ids of the visible conversations Get me to zero would mark Done. */
export function zeroCandidates(folderId: number, opts: ZeroOptions, now = Date.now()): number[] {
  refreshListRows()
  const cutoff = now - Math.max(0, opts.olderThanDays) * 86_400_000
  const rows = getDb()
    .prepare(
      `SELECT newest_id FROM list_rows
        WHERE folder_id = ? AND hidden = 0 AND COALESCE(date, 0) < ?
          ${opts.keepUnread ? 'AND unread_count = 0' : ''}
          ${opts.keepStarred ? 'AND flagged = 0' : ''}`
    )
    .all(folderId, cutoff) as { newest_id: number }[]
  return rows.map((r) => r.newest_id)
}
```

- [x] **Step 5: Create `src/ui/streak.ts`.**

```ts
export interface Streak {
  days: number
  lastDay: string | null
}

/** Local calendar day, YYYY-MM-DD. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Consecutive days that reached inbox zero. Reaching it twice in a day counts once. */
export function nextStreak(prev: Streak, today: string): Streak {
  if (prev.lastDay === today) return prev
  const [y, m, d] = today.split('-').map(Number)
  const yesterday = dayKey(new Date(y, m - 1, d - 1))
  return { days: prev.lastDay === yesterday ? prev.days + 1 : 1, lastDay: today }
}
```

- [x] **Step 6: IPC.** In `electron/ipcTriage.ts`, imports: `shell` from `electron`; `describePlan, planUnsubscribe, runUnsubscribe` from `../src/core/triage/unsubscribe.js`; `zeroCandidates, type ZeroOptions` from `../src/core/triage/zero.js`; `enqueueOutbox` from `../src/core/send/outbox.js`; `holdMove` from `./ipc.js`. Inside `registerTriageIpc()`:

```ts
  // Planned again in run: the renderer only ever sends a message id, never a URL.
  ipcMain.handle('unsubscribe:plan', (_e, rowId: number) => {
    const m = getMessage(rowId)
    const plan = m ? planUnsubscribe(m.list_unsubscribe, !!m.unsubscribe_one_click) : null
    if (!m || !plan) return { ok: false as const, error: 'This sender offers no unsubscribe link' }
    return { ok: true as const, sender: m.from_name || m.from_addr || 'this sender', description: describePlan(plan) }
  })

  ipcMain.handle('unsubscribe:run', async (_e, rowId: number) => {
    const m = getMessage(rowId)
    const plan = m ? planUnsubscribe(m.list_unsubscribe, !!m.unsubscribe_one_click) : null
    if (!m || !plan) return { ok: false as const, error: 'This sender offers no unsubscribe link' }
    return runUnsubscribe(plan, {
      post: async (url) => {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'List-Unsubscribe=One-Click',
          signal: AbortSignal.timeout(15_000)
        })
        return r.ok
      },
      // Through the outbox, from the account that received the mail.
      sendMail: (to, subject, body) => {
        enqueueOutbox({ account_id: m.account_id, draft_message_id: null, to_addrs: to, subject, body_text: body, send_at: Date.now() })
      },
      openUrl: (url) => shell.openExternal(url)
    })
  })

  ipcMain.handle('triage:zero', (_e, folderId: number, opts: ZeroOptions, dryRun: boolean) => {
    const ids = zeroCandidates(folderId, opts)
    if (dryRun) return { ok: true as const, count: ids.length }
    return holdMove(ids, { role: 'archive' })
  })
```

  and in `electron/preload.ts`:

```ts
  unsubscribePlan: (
    rowId: number
  ): Promise<{ ok: true; sender: string; description: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('unsubscribe:plan', rowId),
  unsubscribe: (rowId: number): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('unsubscribe:run', rowId),
  zeroCount: (
    folderId: number,
    opts: { olderThanDays: number; keepUnread: boolean; keepStarred: boolean }
  ): Promise<{ ok: true; count: number }> => ipcRenderer.invoke('triage:zero', folderId, opts, true),
  zero: (
    folderId: number,
    opts: { olderThanDays: number; keepUnread: boolean; keepStarred: boolean }
  ): Promise<
    { ok: true; batchId: number; moved: number[]; holdMs: number } | { ok: false; error: string }
  > => ipcRenderer.invoke('triage:zero', folderId, opts, false),
```

- [x] **Step 7: Components.**

```tsx
// src/ui/views/ConfirmDialog.tsx
import { useEffect, useRef } from 'react'

interface Props {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

/** Enter confirms, Esc cancels. Used wherever an action reaches outside the mailbox. */
export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel }: Props) {
  const okRef = useRef<HTMLButtonElement>(null)
  useEffect(() => okRef.current?.focus(), [])
  return (
    <div className="preview-backdrop" role="alertdialog" aria-modal="true" aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
      }}>
      <div className="picker">
        <div className="picker-title">{title}</div>
        <p className="settings-note">{body}</p>
        <div className="settings-themes">
          <button ref={okRef} type="button" data-on="true" onClick={onConfirm}>{confirmLabel}</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
```

```tsx
// src/ui/views/ZeroModal.tsx
import { useEffect, useState } from 'react'

interface Props {
  folderId: number
  onDone: (opts: { olderThanDays: number; keepUnread: boolean; keepStarred: boolean }) => void
  onCancel: () => void
}

/** Get me to zero: bulk Done with a live count, so nothing happens by surprise. */
export function ZeroModal({ folderId, onDone, onCancel }: Props) {
  const [days, setDays] = useState(7)
  const [keepUnread, setKeepUnread] = useState(true)
  const [keepStarred, setKeepStarred] = useState(true)
  const [count, setCount] = useState<number | null>(null)
  const opts = { olderThanDays: days, keepUnread, keepStarred }

  useEffect(() => {
    void window.api.zeroCount(folderId, { olderThanDays: days, keepUnread, keepStarred }).then((r) => setCount(r.count))
  }, [folderId, days, keepUnread, keepStarred])

  return (
    <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label="Get me to zero"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
      }}>
      <div className="picker">
        <div className="picker-title">Get me to zero</div>
        <label className="picker-check">
          Mark Done everything older than
          <input type="number" min={0} value={days} onChange={(e) => setDays(Math.max(0, Number(e.target.value) || 0))} />
          days
        </label>
        <label className="picker-check">
          <input type="checkbox" checked={keepUnread} onChange={(e) => setKeepUnread(e.target.checked)} /> Keep unread
        </label>
        <label className="picker-check">
          <input type="checkbox" checked={keepStarred} onChange={(e) => setKeepStarred(e.target.checked)} /> Keep starred
        </label>
        <p className="settings-note">{count === null ? '…' : `${count} conversation${count === 1 ? '' : 's'} will be marked Done. You can undo.`}</p>
        <div className="settings-themes">
          <button type="button" data-on="true" disabled={!count} onClick={() => onDone(opts)}>Mark Done</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
```

```tsx
// src/ui/views/ZeroState.tsx
interface Props {
  streak: number
}

/** Shown in place of the empty Inbox. Local only: the streak lives in settings. */
export function ZeroState({ streak }: Props) {
  return (
    <div className="zero-state">
      <svg width="120" height="80" viewBox="0 0 120 80" aria-hidden="true">
        <circle cx="60" cy="52" r="22" fill="none" stroke="currentColor" strokeWidth="2" />
        <line x1="10" y1="52" x2="110" y2="52" stroke="currentColor" strokeWidth="2" />
        <line x1="60" y1="18" x2="60" y2="8" stroke="currentColor" strokeWidth="2" />
        <line x1="34" y1="28" x2="28" y2="21" stroke="currentColor" strokeWidth="2" />
        <line x1="86" y1="28" x2="92" y2="21" stroke="currentColor" strokeWidth="2" />
      </svg>
      <span className="empty-title">Inbox zero</span>
      <span className="empty-sub">
        {streak > 1 ? `${streak} days in a row` : 'Nothing left to triage'}
      </span>
    </div>
  )
}
```

- [x] **Step 8: MessageList hook-in.** Add an optional prop `emptyNode?: ReactNode` to `MessageList` (import the `ReactNode` type from `react`); in the `!rows.length` branch render `{emptyNode ?? (<div className="empty">…existing…</div>)}` inside `.list-scroll`.

- [x] **Step 9: Commands.** Add `'msg.unsubscribe' | 'triage.zero'` to `CommandId` and to `COMMANDS`:

```ts
  { id: 'msg.unsubscribe', title: 'Unsubscribe', group: 'Message', palette: true, keys: [{ kind: 'mod', key: 'u', modes: LIST_THREAD }] },
  { id: 'triage.zero', title: 'Get me to zero…', group: 'General', palette: true, keys: [] },
```

- [x] **Step 10: App wiring** (`src/ui/App.tsx`):
  - Imports: `ConfirmDialog`, `ZeroModal`, `ZeroState`, `dayKey, nextStreak` from `'./streak'`.
  - Extend the overlay union with `| { kind: 'unsubscribe'; id: number; sender: string; description: string } | { kind: 'zero'; folderId: number }`.
  - Streak state and recording (put this above `loadRows`, which calls it):

```ts
  const [streak, setStreak] = useState(0)
  /** Called when the plain Inbox (no split, no chip) loads empty. */
  const recordZero = useCallback(async () => {
    const s = await window.api.getSettings()
    const prev = { days: Number(s.zero_streak_days) || 0, lastDay: s.zero_last_day || null }
    const next = nextStreak(prev, dayKey(new Date()))
    setStreak(next.days)
    if (next.lastDay !== prev.lastDay)
      await window.api.setSettings({ zero_streak_days: String(next.days), zero_last_day: next.lastDay ?? '' })
  }, [])
```

    At the end of `loadRows`, add:

```ts
      const st = useStore.getState()
      if (!rows.length && isInbox(folderId) && st.splitId === 'all' && !st.chip) void recordZero()
```

    (and `recordZero`, `isInbox` to its deps).
  - Handlers:

```ts
        'msg.unsubscribe': async () => {
          const [id] = actionIds()
          if (!id) return
          const p = await window.api.unsubscribePlan(id)
          if (!p.ok) return setSyncError(p.error)
          setOverlay({ kind: 'unsubscribe', id, sender: p.sender, description: p.description })
        },
        'triage.zero': () => {
          const fid = useStore.getState().activeFolderId
          if (fid && isInbox(fid)) setOverlay({ kind: 'zero', folderId: fid })
          else setSyncError('Get me to zero works on the Inbox')
        },
```

  - Render:

```tsx
      {overlay?.kind === 'unsubscribe' && (
        <ConfirmDialog
          title={`Unsubscribe from ${overlay.sender}?`}
          body={overlay.description}
          confirmLabel="Unsubscribe"
          onCancel={() => setOverlay(null)}
          onConfirm={async () => {
            const id = overlay.id
            setOverlay(null)
            const r = await window.api.unsubscribe(id)
            if (!r.ok) setSyncError(r.error)
          }}
        />
      )}
      {overlay?.kind === 'zero' && (
        <ZeroModal
          folderId={overlay.folderId}
          onCancel={() => setOverlay(null)}
          onDone={async (opts) => {
            const fid = overlay.folderId
            setOverlay(null)
            const r = await window.api.zero(fid, opts)
            if (!r.ok) return setSyncError(r.error === 'no archive folder' ? NO_ARCHIVE : r.error)
            await loadRows(fid)
            const n = r.moved.length
            pushUndo(`Done ${n} message${n === 1 ? '' : 's'}`, r.holdMs, async () => {
              const u = await window.api.undoMove(r.batchId)
              if (!u.ok) return setSyncError(u.error)
              await loadRows(fid)
            })
          }}
        />
      )}
```

  - Pass to `<MessageList>`: `emptyNode={active?.role === 'inbox' && splitId === 'all' && !chip && !syncError ? <ZeroState streak={streak} /> : undefined}`.

- [x] **Step 11: Styles.** `.zero-state` (flex column, centred, `gap: var(--space-2)`, `padding-top: var(--space-6)`, `color: var(--text-tertiary)`; the SVG inherits `currentColor`); `.picker-check input[type='number']` (`width: 4em`, `margin: 0 var(--space-1)`).

- [x] **Step 12: Run everything.** `pnpm typecheck && pnpm test`: green (3 more files). In `pnpm dev`: `⌘U` on a newsletter opens the confirm naming the host or address and does nothing until confirmed; on a personal message it says there is no link; in compose `⌘U` still underlines; ⌘K → "Get me to zero…" shows a count that follows the options, marks them Done, and `z` restores them; an empty Inbox shows the art and, the next day, a 2-day streak.

- [ ] **Step 13: Commit.**

```bash
git add src/core/triage/unsubscribe.ts src/core/triage/unsubscribe.test.ts src/core/triage/zero.ts src/core/triage/zero.test.ts src/ui/streak.ts src/ui/streak.test.ts src/ui/views/ConfirmDialog.tsx src/ui/views/ZeroModal.tsx src/ui/views/ZeroState.tsx src/ui/views/MessageList.tsx src/ui/commands.ts src/ui/commands.test.ts src/ui/App.tsx src/ui/styles/app.css electron/ipcTriage.ts electron/preload.ts
git commit -m "[feat] unsubscribe with confirmation, get me to zero, inbox zero streak"
```

---

### Task 11: Docs and end-to-end check

**Files:**
- Modify: `CLAUDE.md`, `README.md`

- [x] **Step 1: Update `CLAUDE.md`.**
  - In **Roadmap**, add a row `| Phase 2 | Done | Triage: list read model, Done, undo window, splits/chips, Remind me, mute, labels, unsubscribe, zero |` and remove "snooze" from the Later row.
  - Under **Local-first rules**, add:

```markdown
6. Lists read `list_rows` (`src/core/store/listRows.ts`), one row per (folder, thread). Triggers on `messages` mark threads dirty in `list_dirty`; `refreshListRows()` rebuilds them before every list read, and `repairListDrift()` runs after each sync. Never GROUP BY messages for a list.
7. Remind me and mute are local: they set `list_rows.hidden` for Inbox rows and never move anything on the server. Exmail's Archive folder is only created from Settings → Done folder.
```

  - Under **Schema**, add:

```markdown
- `reminders` / `mutes` are keyed by account + Message-ID; `vip_senders`, `replied_senders` (trigger-filled) and `splits` back the Important/Other/VIP splits. Splits and chips are list-context `search.ts` queries (`is:needs-reply`, `is:waiting`, `is:important`…).
- `labels` / `message_labels` are account-scoped and hold Gmail X-GM-LABELS only.
- One undo window: `settings.undo_seconds` (3/5/10/20), read by main through `undoWindowMs`; IPC results carry `holdMs` and the renderer's single `UndoEntry` (`z`) uses it.
```

  - Under **Code map**, add `src/core/triage/ — move planning, reminders, local rules, unsubscribe, zero` and `electron/ipcTriage.ts — Phase 2 handlers`.

- [x] **Step 2: Update `README.md`.** In Features, add one line each: Done / Not done with undo (adjustable window), split inbox with Important / Other / VIP and custom splits, filter chips and date grouping, Remind me (local, natural-language times), mute, move and Gmail labels, one-click unsubscribe (always confirms), Get me to zero.

- [x] **Step 3: Full check.** `pnpm typecheck && pnpm test && pnpm build`. All green.

- [ ] **Step 4: Manual end-to-end** in `pnpm dev`, on the Exmail account and on a Gmail account:
  1. **Read model:** open a large Inbox; paging and counts behave as before; the dev console shows no `[perf]` warning for `nav.down`, `msg.done` or `filter.unread`.
  2. **Done:** Exmail without Archive shows the Settings pointer; after creating it, `e` / `z` / `g e` / `E` work and the server shows the moves after the undo window. On Gmail, `e` removes the Inbox label in Gmail web.
  3. **Undo window:** 3 / 5 / 10 / 20 s each change the toast and the delay before Gmail web shows the move.
  4. **Splits and chips:** counts match what each tab shows; ⇧R shows only threads whose last message is from someone else.
  5. **Remind me:** a 2-minute reminder hides and returns the thread with a notification; a reply arriving before then brings it back early.
  6. **Mute, move, label, VIP, spam, unsubscribe, zero:** each works and, where offered, undoes.
  7. **Restart the app** mid-undo-window after a Done: the move reaches the server (existing `flushPendingMoves`), and reminders survive.

- [ ] **Step 5: Commit.**

```bash
git add CLAUDE.md README.md
git commit -m "[docs] phase 2 triage"
```

---

## Self-review notes

- **Spec coverage (Phase 2):**
  - List read model *(Scape)*: table, dirty marking, rebuild-only-dirty, drift repair, replaces `listInbox`'s GROUP BY → Tasks 1–2. Property test from the spec's Verification list → Task 2.
  - Done / Not done `E` / `⇧E`, Exmail archive created only after confirming in Settings, `g e` → Task 6.
  - Undo anything `z`, built on the Phase 0 queue, replaces the send/trash toasts, adjustable window *(Scape)* shared by main and the toast → Task 5 (Task 6 moves the hold into `holdMove`).
  - Filter chips *(Scape)* Unread / Needs reply / Waiting as saved queries that also work as splits → Tasks 4 and 7.
  - Grouping `⇧D` *(Scape)*, headers in the virtual list, no new query → Task 7.
  - Remind me `h`, `⌘⇧H` in compose, local only, keyed by account + Message-ID with `remind_at` / `if_no_reply`, hidden while pending, natural-language picker, `g h` → Task 8. Reminder wake logic and NL date tests → Task 8.
  - Split inbox `Tab` / `⇧Tab`: Important / Other (bulk headers or never-replied senders), VIP, custom, with counts → Tasks 3, 4, 7, 9. Split-query parser test → Task 4.
  - Get me to zero, with keep-unread / keep-starred and undo → Task 10. Inbox zero state + local streak → Task 10.
  - Move / label `v` / `l`, labels Gmail-only via X-GM-LABELS → Tasks 3 and 9. Gmail label mapping test → Task 3.
  - Mute `⇧M` as a local rule → Task 9.
  - Unsubscribe `⌘U`: RFC 8058 one-click POST or mailto, always confirms → Task 10. List-Unsubscribe parsing tests → Tasks 3 and 10.
  - Spam `!` → Task 6. Starred filter `⇧S`, `⌘A`, `⇧J/⇧K` → Task 7.
  - Phase 1 deferrals picked up here: `X-GM-LABELS` (Task 3), archive to All Mail (Task 6).
- **Choices made where the spec was silent:**
  - Mute hides locally and never archives on the server, consistent with Remind me being local.
  - Any reply that arrives after a reminder was set ends it (both `h` and "if no reply"); a fired reminder is cleared when its thread is moved.
  - The default undo window stays 3 s (today's behaviour); the default split is All, so turning splits on cannot hide mail.
  - Triage moves now act on the whole thread in the current folder (`planMoves`), which also fixes Trash on a threaded row moving only its newest message.
  - The pager counts conversations (it showed threads but counted messages).
- **Known gaps:**
  - Gmail's All Mail is not synced (Phase 1), so `g e` on Gmail shows a message instead of a folder, and Done rows there are reachable only from Gmail web. Syncing All Mail needs `X-GM-MSGID` dedupe (spec Risks) and is left for later.
  - Labels show only in the picker; label chips on rows and `label:` search are Phase 3.
  - Reminders, scheduled sends and mutes act only while the app runs (spec decision).
  - A reminder keyed to a message whose Message-ID is missing cannot be set; `h` silently skips those rows (`reminders:set` returns the ids it set).
  - The read model is per folder, so a fired reminder brings its thread back to the Inbox only if the thread has an Inbox row. A thread that lives only in Sent (⌘⇧H on a new mail) or only in Done/Archive fires the notification and shows as fired in `g h`, but does not appear in the Inbox. Showing such threads in the Inbox needs a cross-folder row there, and Done on that row must not MOVE the Sent copy to Archive; left for later.
- **Names used across tasks:**
  - `listRows.ts`: `refreshListRows`, `listView`, `countView`, `listInbox`, `repairListDrift`, `markDirtyByMessageId`, `ListViewOptions`.
  - `search.ts`: `QueryContext`, `parseQuery(input, ctx)`, `listWhere`. `splits.ts`: `Split`, `BUILTIN_SPLITS`, `listSplits`, `saveSplit`, `deleteSplit`, `splitCounts`.
  - `labels.ts`: `userLabels`, `gmailLabelChoices`, `messageLabels`, `setMessageLabels`, `addMessageLabel`, `removeMessageLabel`, `labelsForMessages`. `listHeaders.ts`: `ListHeaders`, `headerValue`, `listHeadersFrom`. `imap.ts`: `ENVELOPE_HEADERS`, `ENVELOPE_QUERY`, `envelopeToRaw`, `fetchLabels`, `storeFlag(..., useLabels)`.
  - `folderRoles.ts`: `doneRole`. `repo.ts`: `setFolderRole`, `threadMatesInFolder`. `movePlan.ts`: `PlannedMove`, `resolveTarget`, `planMoves`. `ipc.ts`: `holdMove`, `flagWriterFor`.
  - `undoWindow.ts`: `UNDO_CHOICES_S`, `DEFAULT_UNDO_S`, `undoWindowMs`. `reminders.ts`: `ReminderRow`, `ReminderSnapshot`, `getReminder`, `setReminder`, `restoreReminders`, `clearReminder`, `dropFiredReminders`, `reminderOutcome`, `lastReplyAt`, `wakeDueReminders`, `listReminderRows`. `localRules.ts`: `toggleMute`, `toggleVip`. `unsubscribe.ts`: `parseListUnsubscribe`, `parseMailto`, `UnsubscribePlan`, `planUnsubscribe`, `describePlan`, `runUnsubscribe`. `zero.ts`: `ZeroOptions`, `zeroCandidates`.
  - UI: `UndoEntry`, `REMINDERS_VIEW_ID`, `extendSelection`, `splitId` / `chip` / `groupByDate` (store); `ChipId`, `CHIPS`, `viewQuery` (chips.ts); `ListItem`, `dateGroup`, `withDateGroups` (listGroups.ts); `parseWhen`, `parseTime`, `laterToday`, `PRESETS` (when.ts); `Streak`, `dayKey`, `nextStreak` (streak.ts); `eventKey` (useHotkeys); `Chord` (useCommandChord); `Overlay`, `pushUndo`, `runUndo`, `actionIds` (App).
  - Settings keys: `undo_seconds`, `list_group_by_date`, `zero_streak_days`, `zero_last_day`.
