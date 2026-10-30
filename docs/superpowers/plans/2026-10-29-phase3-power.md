# Phase 3 — Read / write power Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read and write faster than Superhuman: workspace tabs with history, a unified inbox across accounts, `⌃1–9` account keys and remappable shortcuts, thread reading keys with a position counter, compose power (snippets, Instant Intro, Send + Done, send later, field jumps, cancel-on-reply), richer search with one unified search page, a contact pane, and full offline history. First, fix the Phase 2 carry-over: the Sent copy of a quick second send reaches the local DB late.

**Architecture:**
- **Sent copy, promptly.** After a send, main waits for *that send's* Message-ID to appear in the local Sent folder (`waitForSentCopy`), polling one account at a time (`serialPerKey`). Today it stops at the first poll that stores anything, so a second quick send can stop on the first send's copy.
- **Registry first.** `KeySpec` gains `kind: 'ctrl'` (the physical Control key, never ⌘), so `⌃1–9` switch accounts while `⌘1–9` jump tabs. Every builder takes the command list as a parameter, so a user keymap (`settings.keymap`) can replace a command's primary key (`applyKeymap`). A custom app menu frees `⌘W`, which Electron's default menu spends on Close Window.
- **Unified inbox.** A virtual view (`UNIFIED_VIEW_ID = -2`, next to `REMINDERS_VIEW_ID = -1`) reads `list_rows` for every account's Inbox in one query whose WHERE pins each row to its owner: `(lr.account_id = ? AND lr.folder_id = ?) OR …`. List rows now carry `account_id`; thread reads, read/unread and compose take the account from the row, never from the active account.
- **Workspace tabs.** Pure model in `src/ui/workspace.ts`: tabs, each with its own back/forward history of `View`s (folder or special view, split, chip, optional thread, search query). App never pushes history by hand: a store subscription records the view on screen after every navigation (coalesced over 120 ms), and back/forward/tab switches apply a `View` back onto the store. Persisted in `settings.workspace`.
- **Thread keys** live in an imperative handle on `Thread` (`ThreadHandle`), so App's registry handlers drive message focus, expansion, paging and link cycling without lifting Thread's state.
- **Compose** gains `accountId`, `sourceMessageId` and a send-later picker (the natural-language `RemindPicker`). Snippets are a local `snippets` table; variables expand in the renderer.
- **Cancel on reply** is a pipeline hook: after a synced message is stored, `cancelAndNotify` cancels pending scheduled sends that opted in and belong to that message's thread, and main tells the renderer.
- **Search.** `search.ts` learns `OR`, `-term`, `"phrase"`, `in:`, `label:`, `before:` / `after:`. Gmail accounts can ask the server (`X-GM-RAW`) and store the hits. One search page (`SEARCH_VIEW_ID = -3`, keyboard mode `search`) has Emails / Contacts / Tasks scopes; tasks get an FTS5 index.
- **Contact pane** and **full history** read and fill the local DB only: `contactProfile()` aggregates mail with one person; a history worker walks each synced folder backwards, headers only.
- New main-process handlers go in `electron/ipcPower.ts`; `electron/ipc.ts` changes only where it already owns the handler.

**Tech stack:**
- Electron 43, React 19, TypeScript (strict, `noUnusedLocals`), Zustand 5 (`subscribe(listener(state, prev))`).
- better-sqlite3 13 (FTS5, JSON1, window functions), imapflow 1.4 (`search({ gmraw })`, uid-list `fetch`), vitest 4 (node environment: UI tests cover pure helpers only).

**Spec:** `docs/superpowers/specs/2026-10-18-superhuman-parity-design.md` (Phase 3, including every *(Scape)* item). Scape detail: `docs/research/2026-10-29-scape-teardown.md`. Phase 2 as built: `docs/superpowers/plans/2026-10-29-phase2-triage.md` ("As built").

**Decisions already made (do not reopen):**
- Account switching moves to `⌃1–9`; `⌘1–9` belong to tabs (spec). Off macOS, where ⌘ is Ctrl, `⌃1–9` wins and tabs are reached by `⌃Tab` and clicks.
- `/` opens the search page (Superhuman's key). It was the palette's second key; `⌘K` stays the palette.
- `↵` in a thread is Reply all; `R` stays as its second key, `r` stays Reply.
- `⌘W` closes a tab. The window closes with `⇧⌘W` (custom menu).
- A new tab opens on the current list (no thread). At most 9 tabs; `⌘9` is the last tab, like a browser.
- Snippets are plain text with `{variables}`, global (not per account), like splits.
- "Cancel if someone replies" is offered only for a scheduled reply (a new mail has no thread anyone can answer yet). Default comes from Settings, off unless set.
- Unified inbox is the Inbox of every connected account. It appears only with two or more accounts. "Get me to zero" stays per account.
- Unified search searches mail of every account; Contacts and Tasks search the active account (they are per-account today).
- Full history downloads headers only (bodies stay on demand), on by default, switchable in Settings.

**Deliberately not in Phase 3** (spec Phase 4+): AI of any kind (Ask AI from ⌘K, reply suggestions, summaries), label chips on rows, multi-window, a cross-folder Inbox row for threads living only in Sent.

**Conventions** (same as Phases 0–2):
- Core imports use `.js` suffixes (`'./db.js'`). UI imports have no suffix (`'./store'`); UI tests import with `.js`.
- Migrations are append-only (`src/core/store/migrate.ts`). The last entry is v19 (Phase 2's `list_dirty_au` fix). This plan adds only **v20**.
- DB tests call `closeDb(); initDb(join(mkdtempSync(join(tmpdir(), 'x-')), 't.db'))` in `beforeEach` (see `src/core/store/listRows.test.ts`).
- Run one test file with `pnpm exec vitest run <path>`. Every task ends with `pnpm typecheck && pnpm test` green. Baseline is **60 files / 418 tests**.
- Every new keyboard action is declared in `src/ui/commands.ts` and handled in `App.tsx`, or, for compose-only chords, declared there with `external: true` and handled in `Compose.tsx`. Keys inside an open picker, dialog or the search page's result list (arrows, Enter, Esc, Tab) are local to that component, like `CommandPalette`.
- The renderer never imports runtime code from `src/core`; it talks to main through `window.api` only. Type-only imports are fine. Pure UI helpers live in `src/ui/`.
- Several UI tests read source files as text (`appMode.test.ts`, `viewScope.test.ts`, `threadTarget.test.ts`, `readScope.test.ts`, `selection.test.ts`, `folders.test.ts`, `bodyLinks.test.ts`). When a task changes a line one of them matches, the task says so; update the expected string in the same task, never delete the assertion.
- Commit messages use `[feat]` / `[fix]` / `[refactor]` / `[test]` / `[docs]` and a lower-case summary. **Skip the commit steps if you were told not to commit** (the shared working tree for automated runs is one such case); leave the changes in the tree.

**Key map after Phase 3** (new entries only; check this before adding any key):

| Key | Modes | Command |
|---|---|---|
| `⌘T` / `⌘W` | list, thread, search | `tab.new` / `tab.close` |
| `⌘1`–`⌘9` | list, thread, search | `tab.1`–`tab.9` (`⌘9` = last) |
| `⌃Tab` / `⌃⇧Tab` | list, thread, search | `tab.next` / `tab.prev` |
| `⌘[` / `⌘]` | list, thread, search | `history.back` / `history.forward` |
| `⌃1`–`⌃9` | list, thread | `account.1`–`account.9` |
| `g a` | list | `go.unified` |
| `/` | list, thread | `search.open` (was the palette's second key) |
| `o` / `O` | thread | `thread.expand` / `thread.expandAll` |
| `n` / `p` | thread | `thread.nextMsg` / `thread.prevMsg` |
| `j` / `k` | thread | `thread.nextConv` / `thread.prevConv` |
| `Space` / `⇧Space` | thread | `thread.pageDown` / `thread.pageUp` |
| `Tab` / `⇧Tab` | thread | `thread.nextLink` / `thread.prevLink` |
| `⌘O` | thread | `thread.open` (selected link, else first attachment) |
| `↵` (and `⇧R`) | thread | `thread.replyAll` |
| `i` | thread | `thread.contactPane` |
| `⌘⇧↵` | compose | `compose.sendDone` |
| `⌘⇧L` | compose | `compose.sendLater` |
| `⌘⇧I` | compose | `compose.intro` |
| `⌘⇧O` / `⌘⇧C` / `⌘⇧B` / `⌘⇧S` | compose | `compose.focusTo` / `focusCc` / `focusBcc` / `focusSubject` |
| `⌘;` | compose | `compose.snippet` |
| `;name` then `⇥` | compose body | expand a snippet inline (editor-local, not a command) |

---

## As built (2026-10-30)

All tasks are implemented; `pnpm typecheck`, `pnpm test` (**81 files / 580 tests**, baseline was 60 / 418) and `pnpm build` are green. Commit steps were skipped (shared working tree), and the in-app checks (Tasks 5–8, 11) and the manual end-to-end (Task 12 Step 11) have not been run. Deviations from the plan:

- **v20 adds `idx_messages_from`** (`account_id, lower(from_addr)`): the contact pane looks people up by sender on every thread open.
- **Backfill is gap-aware, not "below the oldest uid".** `backfillFolder` searches server uids up to `backfillCeiling` (max of newest local uid and `last_uid`) and fetches the newest missing ones (`backfillPlan` / `missingUids`), so a Gmail server-search hit stored far below the window leaves no hole. It returns `more: true` and stores nothing when the live UIDVALIDITY differs (`liveUidValidity`).
- **No date floor with full history on.** `forwardCutoff` is 0 unless `full_history` is `'0'`; when the cutoff drops mail, `reopenHistory` clears `history_complete` so backfill fetches it.
- **History worker split for testing.** `runBackfillExclusive` lives in `electron/backfillLock.ts` (not `ipc.ts`) and takes `{ wait }`, so Load older waits for a worker page instead of failing. `electron/historyTick.ts` holds `createHistoryTick` (each account tried on its own; a folder that throws sits out 15 minutes) and `forwardSynced` (local rows or `last_uid > 0`, replacing `oldestSyncedUid() !== null`). `setHistoryComplete(folderId, uidvalidity)` only sets the flag if the uidvalidity it read is still current.
- **Every-account paths check each owner.** `electron/syncAll.ts` (`syncAllAccounts`: one failed account does not stop `sync:runAll`); `labels.sharedLabelChoices` / `labelWriteError` (a mixed selection is offered only labels every owner has, checked before any write); `outbox.listScheduledOutbox` (the scheduled list reads every account, since a unified-inbox reply queues under its own account).
- **imapflow fix found on the way.** `fetchEnvelopes` NOOPs a mailbox a pooled connection already had open and UID FETCHes instead of trusting its stale `uidNext`. The post-send Sent refresh (Task 1) reuses a pooled connection, so it depends on this.
- **Extra UI helpers.** `keyLayers.ts` (the shortcut recorder sees Esc before Settings closes), `searchKeys.ts` (Tab / ⇧Tab step search scopes; `SearchCache` keeps results in the store so Esc from an opened result repaints the same scope and row, and `j` / `k` there step email results; `searchStatus`).
- **Docs.** CLAUDE.md also gained the imapflow rule, the gap-aware backfill rule and the every-account rule; code map lists `backfillLock.ts`, `historyTick.ts`, `syncAll.ts`.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/core/send/sentRefresh.ts`, `.test.ts` | create | `waitForSentCopy`, `hasSentCopy`, `serialPerKey` |
| `src/core/send/flush.ts` | modify | `flushOutboxRow` returns the sent Message-ID; `onSent(accountId, messageId)` |
| `src/core/send/remindOnSend.test.ts` | modify | new return shape; `onSent` gets the Message-ID |
| `electron/workers.ts`, `electron/main.ts` | modify | Sent refresh waits for the send's own copy; menu, Phase 3 IPC, history worker |
| `src/core/store/migrate.ts`, `migrate.test.ts` | modify | v20: `outbox.cancel_on_reply`, `folders.history_complete`, `snippets`, `tasks_fts` |
| `src/core/store/repo.ts`, `types.ts` | modify | `account_id` in `LIST_COLS` / `MessageListRow`; `setHistoryComplete`; `resetFolder` clears it |
| `src/ui/hooks/useHotkeys.ts`, `useCommandChord.ts` | modify | `MODES`; `Space` / `Shift+Space`; ⌃ chords |
| `src/ui/commands.ts`, `commands.test.ts` | modify | `ctrl` keys, `sheet`, command-list parameter, every new command |
| `src/ui/keymap.ts`, `.test.ts` | create | remappable shortcuts |
| `src/ui/views/ShortcutSettings.tsx` | create | record / reset a shortcut |
| `electron/menu.ts` | create | app menu without `⌘W` on Close Window |
| `src/core/store/listRows.ts` | modify | export `LIST_ROW_COLS` |
| `src/core/store/unified.ts`, `.test.ts` | create | unified inbox reads, scoped per account |
| `electron/ipcPower.ts` | create | Phase 3 handlers: unified, snippets, search, contacts |
| `electron/ipc.ts`, `electron/preload.ts` | modify | account-scoped thread / compose calls, `sync:runAll`, `runBackfillExclusive`, new API |
| `src/ui/accountGroups.ts`, `.test.ts` | create | group threads by owning account |
| `src/ui/workspace.ts`, `.test.ts` | create | tabs and history model |
| `src/ui/views/TabBar.tsx` | create | tab strip with back / forward |
| `src/ui/threadNav.ts`, `.test.ts` | create | message focus, link cycling, position label |
| `src/ui/views/Thread.tsx`, `MessageBody.tsx` | modify | `ThreadHandle`, counter, links / attachments out |
| `src/ui/intro.ts`, `.test.ts` | create | Instant Intro |
| `src/ui/views/Compose.tsx`, `RecipientField.tsx`, `RemindPicker.tsx` | modify | field jumps, Send + Done, send later, intro, snippets, cancel-on-reply |
| `src/core/store/snippets.ts`, `.test.ts` | create | snippet storage |
| `src/ui/snippetVars.ts`, `.test.ts` | create | variables and inline trigger |
| `src/ui/views/SnippetSettings.tsx` | create | snippet editor |
| `src/ui/richText.ts` | modify | `captureCaret` |
| `src/core/send/cancelOnReply.ts`, `.test.ts` | create | cancel scheduled sends on a reply |
| `src/core/send/outbox.ts`, `src/core/pipeline/pipeline.ts` | modify | `cancel_on_reply`; hook after store |
| `src/core/store/search.ts`, `searchOps.test.ts` | modify / create | new operators |
| `src/core/sync/serverSearch.ts`, `.test.ts`; `syncEngine.ts` | create / modify | Gmail `X-GM-RAW`; `fetchUids` |
| `src/core/store/searchAll.ts`, `.test.ts` | create | merge per-account results |
| `src/core/store/tasks.ts`, `tasks.test.ts` | modify | `searchTasks` |
| `src/core/store/contacts.ts`, `.test.ts` | create | `contactProfile`, `threadCounterpart` |
| `src/ui/views/SearchPage.tsx`, `ContactPane.tsx` | create | search page, contact pane |
| `src/ui/appMode.ts`, `appMode.test.ts` | modify | `search` mode |
| `src/core/sync/historyPlan.ts`, `.test.ts`; `electron/historyWorker.ts` | create | full offline history |
| `src/ui/store.ts`, `src/ui/App.tsx`, `src/ui/views/Sidebar.tsx`, `MessageList.tsx`, `Settings.tsx`, `ShortcutHelp.tsx`, `TriageSettings.tsx`, `src/ui/styles/app.css` | modify | wiring and styles |
| `README.md`, `CLAUDE.md` | modify | docs |

---

### Task 0: Baseline

- [x] **Step 1: Check the baseline.** Run `pnpm typecheck && pnpm test`. Expect typecheck clean and **60 files / 418 tests** passing. If the counts differ, note the new numbers and carry on; later counts are deltas.
- [x] **Step 2: Read the touch points once.** `src/ui/commands.ts` (whole file), `src/ui/App.tsx` (`loadRows`, `fetchPage`, `openRow`, `openThreadAndRead`, `triageFromThread`, `startReply`, `handlers`, `onSent`, the boot `useEffect`), `src/ui/store.ts`, `electron/ipc.ts` (`thread:*`, `compose:*`, `messages:loadOlder`, `sync:run`), `electron/preload.ts`, `src/core/store/search.ts`, `src/core/store/listRows.ts`, `src/core/send/flush.ts`, `electron/workers.ts`.

---

### Task 1: The Sent copy of a quick second send arrives promptly

Phase 2 QA: after two quick sends, the second Sent copy took 20–30 s to reach the local DB, so remind-on-send attached late. Cause: `refreshSentFolder` (`electron/workers.ts`) returns at the first poll that stores *anything* (`n > 0`), and two refreshes run at once on one pool. The second send's poll can store the first send's copy, see `n > 0`, and stop before its own copy is filed; that copy then waits for the 60 s background sync. Fix: wait for this send's own Message-ID, one refresh per account at a time.

**Files:**
- Create: `src/core/send/sentRefresh.ts`, `src/core/send/sentRefresh.test.ts`
- Modify: `src/core/send/flush.ts`, `src/core/send/remindOnSend.test.ts`, `electron/workers.ts`, `electron/main.ts`

- [x] **Step 1: Write the failing tests.** Create `src/core/send/sentRefresh.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { upsertMessage } from '../store/repo.js'
import { hasSentCopy, serialPerKey, waitForSentCopy } from './sentRefresh.js'

const noSleep = async (): Promise<void> => {}

describe('waitForSentCopy', () => {
  it('keeps polling after a poll that only brought an earlier send', async () => {
    // Two quick sends: the second send's first poll stores the FIRST copy
    // (n = 1). That used to end the wait before the second copy was filed.
    let polls = 0
    let mine = false
    const found = await waitForSentCopy({
      poll: async () => {
        polls++
        if (polls === 2) mine = true
        return 1
      },
      stored: () => mine,
      sleep: noSleep
    })
    expect(found).toBe(true)
    expect(polls).toBe(2)
  })

  it('does not poll when the copy is already local', async () => {
    let polls = 0
    const found = await waitForSentCopy({
      poll: async () => ++polls,
      stored: () => true,
      sleep: noSleep
    })
    expect([found, polls]).toEqual([true, 0])
  })

  it('gives up after the attempts it was given', async () => {
    let polls = 0
    const slept: number[] = []
    const found = await waitForSentCopy({
      poll: async () => {
        polls++
        return 0
      },
      stored: () => false,
      sleep: async (ms) => void slept.push(ms),
      attempts: 3,
      intervalMs: 10
    })
    expect([found, polls]).toEqual([false, 3])
    // No sleep after the last attempt.
    expect(slept).toEqual([10, 10])
  })
})

describe('serialPerKey', () => {
  it('runs one account at a time, in order, and other accounts alongside', async () => {
    const run = serialPerKey()
    const log: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const a1 = run(1, async () => {
      log.push('a1 start')
      await gate
      log.push('a1 end')
    })
    const a2 = run(1, async () => void log.push('a2'))
    const b1 = run(2, async () => void log.push('b1'))
    await b1
    expect(log).toEqual(['a1 start', 'b1'])
    release()
    await Promise.all([a1, a2])
    expect(log).toEqual(['a1 start', 'b1', 'a1 end', 'a2'])
  })

  it('keeps going after a task fails', async () => {
    const run = serialPerKey()
    await expect(run(1, async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await expect(run(1, async () => 7)).resolves.toBe(7)
  })
})

describe('hasSentCopy', () => {
  beforeEach(() => {
    closeDb()
    initDb(join(mkdtempSync(join(tmpdir(), 'sentcopy-')), 't.db'))
    const db = getDb()
    db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
    db.prepare(
      "INSERT INTO folders (id,account_id,path,name,role) VALUES (1,1,'Sent','Sent','sent'),(2,1,'INBOX','INBOX','inbox')"
    ).run()
  })

  it('finds the copy by Message-ID in that folder only', () => {
    upsertMessage({
      account_id: 1,
      folder_id: 1,
      uid: 5,
      message_id: '<s1@x>',
      thread_id: '<s1@x>',
      in_reply_to: null,
      from_addr: 'me@x.test',
      from_name: null,
      to_addrs: '[]',
      cc_addrs: '[]',
      subject: 'Hi',
      date: 1,
      snippet: null
    })
    expect(hasSentCopy(1, 1, '<s1@x>')).toBe(true)
    expect(hasSentCopy(1, 2, '<s1@x>')).toBe(false)
    expect(hasSentCopy(1, 1, '<s2@x>')).toBe(false)
  })
})
```

  In `src/core/send/remindOnSend.test.ts`:
  - Change the import to `import { flushDueOutbox, flushOutboxRow } from './flush.js'`.
  - Replace each of the three `toEqual({ ok: true })` with `toEqual({ ok: true, messageId: '<sent-1@x.test>' })`.
  - Add inside the `describe`:

```ts
  it('hands the sent Message-ID to onSent, so the Sent refresh waits for that copy', async () => {
    enqueueOutbox({ account_id: 1, draft_message_id: null, to_addrs: 'a@x.test', send_at: Date.now() - 1 })
    const sent: [number, string][] = []
    expect(await flushDueOutbox(() => config, undefined, (a, id) => void sent.push([a, id]))).toBe(1)
    expect(sent).toEqual([[1, '<sent-1@x.test>']])
  })
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/core/send/sentRefresh.test.ts src/core/send/remindOnSend.test.ts`. Expected: FAIL (missing module; `messageId` missing from the result).

- [x] **Step 3: Create `src/core/send/sentRefresh.ts`.**

```ts
import { getDb } from '../store/db.js'

/**
 * Exmail files the Sent copy ~1.3 s after SMTP returns; the measured worst case
 * was well under 15 s. Past that, the 60 s background sync is the safety net.
 */
export const SENT_POLL_ATTEMPTS = 12
export const SENT_POLL_INTERVAL_MS = 1_500

export interface SentWaitDeps {
  /** One refresh of the Sent folder. Resolves to how many rows it stored. */
  poll: () => Promise<number>
  /** True once this send's own copy is in the local Sent folder. */
  stored: () => boolean
  sleep?: (ms: number) => Promise<void>
  attempts?: number
  intervalMs?: number
}

/**
 * Polls until this send's copy is local. Rows stored by a poll do not end the
 * wait: with two quick sends they can be the other send's copy.
 */
export async function waitForSentCopy(d: SentWaitDeps): Promise<boolean> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const attempts = d.attempts ?? SENT_POLL_ATTEMPTS
  for (let i = 0; i < attempts; i++) {
    if (d.stored()) return true
    await d.poll()
    if (d.stored()) return true
    if (i < attempts - 1) await sleep(d.intervalMs ?? SENT_POLL_INTERVAL_MS)
  }
  return false
}

export function hasSentCopy(accountId: number, folderId: number, messageId: string): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM messages WHERE account_id = ? AND folder_id = ? AND message_id = ? LIMIT 1')
    .get(accountId, folderId, messageId)
}

/**
 * Runs tasks for one key one at a time, in call order; different keys run
 * side by side. Two Sent refreshes on one account would otherwise read the
 * same last_uid and race to store the same rows.
 */
export function serialPerKey(): <T>(key: number, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<number, Promise<unknown>>()
  return <T>(key: number, task: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(task)
    tails.set(key, next)
    next
      .finally(() => {
        if (tails.get(key) === next) tails.delete(key)
      })
      .catch(() => {})
    return next
  }
}
```

- [x] **Step 4: Return the Message-ID from the flush.** In `src/core/send/flush.ts`:
  - Change `flushOutboxRow`'s return type to `Promise<{ ok: true; messageId: string } | { ok: false; error: string }>`.
  - After `const result = await sendSmtp(...)`, add `const sentId = result.messageId || messageId`, use `sentId` in place of both `result.messageId || messageId` expressions below it (the reminder and `appendToSent`), and change the success return to `return { ok: true, messageId: sentId }`.
  - Change the `onSent` parameter type in **both** `flushDueOutbox` and `startOutboxWorker` to `onSent?: (accountId: number, messageId: string) => void`, and in `flushDueOutbox` call `onSent?.(current.account_id, res.messageId)`.

- [x] **Step 5: Wait for the send's own copy.** Replace everything in `electron/workers.ts` from the `SENT_POLL_ATTEMPTS` constants down (keep `startAccountWorkers` and `stopAccountWorkers`, delete the old constants and the old `refreshSentFolder`) so the file reads:

```ts
import { BrowserWindow } from 'electron'
import type { AccountConfig } from '../src/core/accounts/config.js'
import { startIdleWatcher, stopIdleWatcher } from '../src/core/sync/idle.js'
import { closePool, getPool } from '../src/core/sync/pool.js'
import { refreshFolderNow } from '../src/core/sync/syncEngine.js'
import { findFolderByPath, folderByRole } from '../src/core/store/repo.js'
import { hasSentCopy, serialPerKey, waitForSentCopy } from '../src/core/send/sentRefresh.js'

/** Warmed pool + parked IDLE connection for one account. */
export function startAccountWorkers(config: AccountConfig): void {
  // Pay the ~2.7s handshake now, while nothing is waiting on it.
  void getPool(config).warm()
  startIdleWatcher(config, () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('mail:new')
  })
}

export function stopAccountWorkers(email: string): void {
  stopIdleWatcher(email)
  void closePool(email)
}

const sentRefreshes = serialPerKey()

/**
 * Pulls the just-sent copy into the local Sent folder.
 *
 * The server files it asynchronously and the IDLE watcher only holds INBOX
 * open, so without this the message waits for the 60s background poll. Waits
 * for `messageId` itself: with two quick sends, a poll can bring the other
 * send's copy. One refresh per account at a time, on the shared pool.
 */
export function refreshSentFolder(
  accountId: number,
  config: AccountConfig,
  messageId: string | null
): Promise<void> {
  return sentRefreshes(accountId, async () => {
    const path = folderByRole(accountId, 'sent')?.path
    if (!path) return
    let storedAny = false
    try {
      const found = await waitForSentCopy({
        poll: async () => {
          // Re-read: last_uid moves when a poll or the background sync stores
          // rows, and a stale cursor would re-fetch what is already local.
          const folder = findFolderByPath(accountId, path)
          if (!folder) return 0
          const n = await getPool(config).withConnection((client) =>
            refreshFolderNow(client, accountId, {
              id: folder.id,
              path: folder.path,
              last_uid: folder.last_uid
            })
          )
          if (n > 0) {
            storedAny = true
            for (const w of BrowserWindow.getAllWindows())
              w.webContents.send('mail:sent-stored', { accountId, folderId: folder.id })
          }
          return n
        },
        stored: () => {
          const folder = findFolderByPath(accountId, path)
          if (!folder) return true
          // Without a Message-ID (never expected), any new row ends the wait, as before.
          return messageId ? hasSentCopy(accountId, folder.id, messageId) : storedAny
        }
      })
      if (!found) console.warn(`[send] Sent copy ${messageId ?? ''} not seen yet; background sync will pick it up`)
    } catch (err) {
      // The background sync still picks it up; this is only the fast path.
      console.error('[send] Sent refresh failed:', err)
    }
  })
}
```

- [x] **Step 6: Pass the Message-ID from main.** In `electron/main.ts`, change the last argument of `startOutboxWorker` to:

```ts
    (accountId, messageId) => {
      const acct = getAccount(accountId)
      if (acct) void refreshSentFolder(accountId, acct.config, messageId)
    }
```

- [x] **Step 7: Run the tests, then the suite.** `pnpm exec vitest run src/core/send` passes; `pnpm typecheck && pnpm test` green (**61 files**).

- [ ] **Step 8: Commit.**

```bash
git add src/core/send electron/workers.ts electron/main.ts
git commit -m "[fix] wait for the send's own Sent copy, one refresh per account"
```

---

### Task 2: Schema v20 and the owning account on list rows

Every table Phase 3 needs, in one migration, plus `account_id` on every list row so the unified inbox, search and tabs can act on the row's own account.

**Files:**
- Modify: `src/core/store/migrate.ts`, `src/core/store/migrate.test.ts`, `src/core/store/repo.ts`, `src/core/store/types.ts`, `src/core/store/listRows.test.ts`

- [x] **Step 1: Write the failing tests.** Append to `src/core/store/migrate.test.ts`:

```ts
describe('migration v20 (phase 3)', () => {
  it('adds cancel_on_reply, history_complete, snippets and a task index that stays current', () => {
    const db = new Database(join(mkdtempSync(join(tmpdir(), 'migrate-')), 't.db'))
    db.pragma('foreign_keys = ON')
    migrate(db, 19)
    db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
    db.prepare(
      `INSERT INTO tasks (account_id,title,description,created_at,updated_at,sort_order)
       VALUES (1,'Call the bank','about the loan',1,1,0)`
    ).run()

    expect(migrate(db)).toBeGreaterThanOrEqual(20)

    const cols = (t: string) =>
      (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('outbox')).toContain('cancel_on_reply')
    expect(cols('folders')).toContain('history_complete')
    expect(cols('snippets')).toEqual(
      expect.arrayContaining(['id', 'name', 'shortcut', 'body', 'created_at', 'updated_at'])
    )

    const hit = (q: string) => db.prepare('SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH ?').all(q)
    // Existing tasks are indexed, and the index follows updates and deletes.
    expect(hit('bank')).toEqual([{ rowid: 1 }])
    db.prepare("UPDATE tasks SET title = 'Call the insurer' WHERE id = 1").run()
    expect(hit('bank')).toEqual([])
    expect(hit('insurer')).toEqual([{ rowid: 1 }])
    db.prepare('DELETE FROM tasks WHERE id = 1').run()
    expect(hit('insurer')).toEqual([])

    // Snippet shortcuts are unique, ignoring case; a snippet may have none.
    const ins = db.prepare(
      'INSERT INTO snippets (name, shortcut, body, created_at, updated_at) VALUES (?, ?, ?, 1, 1)'
    )
    ins.run('Thanks', 'thx', 'Thanks!')
    expect(() => ins.run('Again', 'THX', 'x')).toThrow()
    ins.run('No key 1', null, 'a')
    ins.run('No key 2', null, 'b')
    db.close()
  })
})
```

  Append inside the top-level `describe` of `src/core/store/listRows.test.ts` (use whichever `describe` holds the `listView` tests):

```ts
  it('carries the owning account on every row', () => {
    add({ thread: '<t@x>', date: 100 })
    expect(listView(inbox).map((r) => r.account_id)).toEqual([ACC])
  })
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/core/store/migrate.test.ts src/core/store/listRows.test.ts`. Expected: FAIL (`expected 19 to be greater than or equal to 20`; `account_id` undefined).

- [x] **Step 3: Append v20** to the `migrations` array in `src/core/store/migrate.ts`, after the v19 entry:

```ts
  // v20: Phase 3.
  // - outbox.cancel_on_reply: a scheduled reply is cancelled when someone
  //   answers the thread first (cancelOnReply.ts).
  // - folders.history_complete: the full-history worker has reached uid 1.
  // - snippets: plain-text templates with {variables}, inserted in compose.
  // - tasks_fts: the unified search page's Tasks scope. External content,
  //   kept aligned by triggers like messages_fts.
  (db) =>
    db.exec(`
ALTER TABLE outbox ADD COLUMN cancel_on_reply INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folders ADD COLUMN history_complete INTEGER NOT NULL DEFAULT 0;

CREATE TABLE snippets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  shortcut TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_snippets_shortcut ON snippets (lower(shortcut)) WHERE shortcut IS NOT NULL;

CREATE VIRTUAL TABLE tasks_fts USING fts5(
  title, description,
  content='tasks', content_rowid='id'
);
INSERT INTO tasks_fts (rowid, title, description) SELECT id, title, description FROM tasks;

CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts (rowid, title, description) VALUES (new.id, new.title, new.description);
END;
CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts (tasks_fts, rowid, title, description)
  VALUES ('delete', old.id, old.title, old.description);
END;
CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, description ON tasks BEGIN
  INSERT INTO tasks_fts (tasks_fts, rowid, title, description)
  VALUES ('delete', old.id, old.title, old.description);
  INSERT INTO tasks_fts (rowid, title, description) VALUES (new.id, new.title, new.description);
END;
`)
```

- [x] **Step 4: Put the account on list rows.**
  - In `src/core/store/repo.ts`, change `LIST_COLS` to:

```ts
export const LIST_COLS =
  'id, account_id, thread_id, from_addr, from_name, to_addrs, subject, date, snippet, flags, has_attachments'
```

  - In `src/core/store/types.ts`, add `| 'account_id'` to the `Pick<Message, …>` list of `MessageListRow` (after `'id'`).

- [x] **Step 5: Run the tests, then the suite.** The two new tests pass. Run `pnpm typecheck && pnpm test`. Any existing test that compares whole list rows with `toEqual` now also sees `account_id`; add `account_id: <that test's account id>` to those expected objects (do not loosen them to `toMatchObject`). Typecheck flags any object literal typed `MessageListRow` that lacks `account_id`; add it there too. All green.

- [ ] **Step 6: Commit.**

```bash
git add src/core/store
git commit -m "[feat] schema v20 for phase 3; list rows carry their account"
```

---

### Task 3: Registry — ⌃ chords, the app menu, account keys and remappable shortcuts

**Files:**
- Create: `src/ui/keymap.ts`, `src/ui/keymap.test.ts`, `src/ui/views/ShortcutSettings.tsx`, `electron/menu.ts`
- Modify: `src/ui/hooks/useHotkeys.ts`, `src/ui/hooks/useCommandChord.ts`, `src/ui/commands.ts`, `src/ui/commands.test.ts`, `src/ui/views/ShortcutHelp.tsx`, `src/ui/views/Settings.tsx`, `src/ui/App.tsx`, `src/ui/styles/app.css`, `electron/main.ts`

- [x] **Step 1: Write the failing tests.** In `src/ui/commands.test.ts`:
  - Change the first import to `import { eventKey, MODES, type Mode } from './hooks/useHotkeys.js'`, add `type Handlers` to the `./commands.js` import, and replace `const ALL_MODES: Mode[] = ['list', 'thread', 'compose', 'modal']` with `const ALL_MODES: Mode[] = MODES`.
  - Add inside `describe('command registry', ...)`:

```ts
  it('never reuses a ⌃ chord in the same mode', () => {
    const seen = new Map<string, string>()
    for (const c of COMMANDS) {
      for (const k of c.keys) {
        if (k.kind !== 'ctrl') continue
        for (const m of k.modes ?? ALL_MODES) {
          const slot = `${m}:${k.shift ? '⇧' : ''}${k.key.toLowerCase()}`
          expect(seen.get(slot), `${slot} is bound by ${seen.get(slot)} and ${c.id}`).toBeUndefined()
          seen.set(slot, c.id)
        }
      }
    }
  })

  it('switches accounts on ⌃1–⌃9, never on ⌘, and not while composing', () => {
    const h = { 'account.1': () => {}, 'account.9': () => {} } as Handlers
    const chords = buildChords('list', h)
    const ev = (key: string, metaKey: boolean, ctrlKey: boolean) => ({
      key,
      metaKey,
      ctrlKey,
      altKey: false,
      shiftKey: false
    })
    expect(matchChord(chords, ev('1', false, true), false)?.key).toBe('1')
    expect(matchChord(chords, ev('9', false, true), true)?.key).toBe('9')
    expect(matchChord(chords, ev('1', true, false), false)).toBeUndefined()
    expect(buildChords('compose', h)).toEqual([])
  })

  it('lets a ⌃ chord win over a ⌘ chord on the same key', () => {
    const ran: string[] = []
    const chords = [
      { key: '1', handler: () => void ran.push('mod') },
      { key: '1', ctrl: true, handler: () => void ran.push('ctrl') }
    ]
    const ev = { key: '1', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }
    matchChord(chords, ev, false)?.handler({} as KeyboardEvent)
    matchChord(chords, { ...ev, metaKey: true, ctrlKey: false }, false)?.handler({} as KeyboardEvent)
    expect(ran).toEqual(['ctrl', 'mod'])
  })

  it('draws ⌃ keycaps and lists the account keys as one sheet row', () => {
    expect(keyCaps({ kind: 'ctrl', key: 'Tab', shift: true })).toEqual(['⌃', '⇧', '⇥'])
    expect(keyCaps({ kind: 'ctrl', key: '1' })).toEqual(['⌃', '1'])
    const general = shortcutGroups().find((g) => g.title === 'General')!
    expect(general.items.filter((i) => i.label.startsWith('Switch to account'))).toEqual([
      { label: 'Switch to account 1–9', keys: ['⌃', '1–9'] }
    ])
  })

  it('builds from any command list, so a keymap can replace keys', () => {
    const only = COMMANDS.filter((c) => c.id === 'msg.star').map((c) => ({
      ...c,
      keys: [{ kind: 'key' as const, key: 'y', modes: ['list' as const] }]
    }))
    expect(buildBindings('list', { 'msg.star': () => {} }, only).map((b) => b.key)).toEqual(['y'])
    expect(shortcutGroups(only).flatMap((g) => g.items.map((i) => i.keys))).toEqual([['y']])
  })
```

  Create `src/ui/keymap.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { COMMANDS, type Command } from './commands.js'
import { applyKeymap, isRemappable, keymapConflicts, parseKeymap, specFromEvent } from './keymap.js'

const find = (id: string) => COMMANDS.find((c) => c.id === id)!

describe('remappable shortcuts', () => {
  it('starts from a registry with no conflicts', () => {
    expect(keymapConflicts(COMMANDS)).toEqual([])
  })

  it('reads only known commands and well-formed keys', () => {
    expect(
      parseKeymap(
        '{"msg.done":{"kind":"key","key":"y"},"nope":{"kind":"key","key":"q"},"msg.star":{"kind":"seq"},"msg.read":{"kind":"mod","key":"j","shift":true}}'
      )
    ).toEqual({
      'msg.done': { kind: 'key', key: 'y' },
      'msg.read': { kind: 'mod', key: 'j', shift: true }
    })
    expect(parseKeymap('not json')).toEqual({})
    expect(parseKeymap('[1]')).toEqual({})
    expect(parseKeymap(undefined)).toEqual({})
  })

  it('replaces the primary key and keeps its modes and any second key', () => {
    const cmds: Command[] = [
      {
        id: 'thread.replyAll',
        title: 'Reply all',
        group: 'In a thread',
        keys: [
          { kind: 'key', key: 'R', modes: ['thread'] },
          { kind: 'key', key: 'Q', modes: ['thread'] }
        ]
      }
    ]
    expect(applyKeymap(cmds, { 'thread.replyAll': { kind: 'key', key: 'a' } })[0].keys).toEqual([
      { kind: 'key', key: 'a', modes: ['thread'] },
      { kind: 'key', key: 'Q', modes: ['thread'] }
    ])
  })

  it('gives a keyless command list-and-thread modes when it gets a single key', () => {
    const vip = applyKeymap(COMMANDS, { 'msg.vip': { kind: 'key', key: 'V' } }).find(
      (c) => c.id === 'msg.vip'
    )!
    expect(vip.keys).toEqual([{ kind: 'key', key: 'V', modes: ['list', 'thread'] }])
  })

  it('reports a key two commands would share in one mode', () => {
    const cmds = applyKeymap(COMMANDS, { 'msg.done': { kind: 'key', key: 's' } })
    expect(keymapConflicts(cmds).join('\n')).toMatch(/Star and Done|Done and Star/)
  })

  it('refuses a single key that starts a g sequence', () => {
    const cmds = applyKeymap(COMMANDS, { 'msg.done': { kind: 'key', key: 'g' } })
    expect(keymapConflicts(cmds).join('\n')).toMatch(/sequence/)
  })

  it('does not remap compose-editor keys, sequences or the numbered families', () => {
    expect(isRemappable(find('compose.send'))).toBe(false)
    expect(isRemappable(find('go.inbox'))).toBe(false)
    expect(isRemappable(find('account.1'))).toBe(false)
    expect(isRemappable(find('account.2'))).toBe(false)
    expect(isRemappable(find('msg.vip'))).toBe(true)
    expect(isRemappable(find('msg.done'))).toBe(true)
  })

  it('reads a recorded key press', () => {
    const ev = (key: string, o: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...o
    })
    expect(specFromEvent(ev('y'))).toEqual({ kind: 'key', key: 'y' })
    expect(specFromEvent(ev('Y', { shiftKey: true }))).toEqual({ kind: 'key', key: 'Y' })
    expect(specFromEvent(ev('Tab', { shiftKey: true }))).toEqual({ kind: 'key', key: 'Shift+Tab' })
    expect(specFromEvent(ev('J', { metaKey: true, shiftKey: true }))).toEqual({ kind: 'mod', key: 'j', shift: true })
    expect(specFromEvent(ev('k', { metaKey: true }))).toEqual({ kind: 'mod', key: 'k' })
    expect(specFromEvent(ev('Shift', { shiftKey: true }))).toBeNull()
    expect(specFromEvent(ev('x', { altKey: true }))).toBeNull()
    expect(specFromEvent(ev('1', { ctrlKey: true }))).toBeNull()
    expect(specFromEvent(ev('Escape'))).toBeNull()
  })
})
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/ui/commands.test.ts src/ui/keymap.test.ts`. Expected: FAIL (`MODES` not exported, no `ctrl` kind, missing module).

- [x] **Step 3: Export the mode list.** In `src/ui/hooks/useHotkeys.ts`, under the `Mode` type, add:

```ts
/** Every mode, for registry checks. Add a mode here and in `Mode` together. */
export const MODES: Mode[] = ['list', 'thread', 'compose', 'modal']
```

- [x] **Step 4: Teach chords about Control.** Replace `Chord` and `matchChord` in `src/ui/hooks/useCommandChord.ts`:

```ts
export interface Chord {
  key: string
  /** ⌘⇧ chords set this; a plain ⌘ chord does not fire with Shift held. */
  shift?: boolean
  /** The physical Control key alone (⌃1, ⌃Tab), never ⌘. */
  ctrl?: boolean
  handler: (e: KeyboardEvent) => void
}

type ChordEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/**
 * The chord `e` triggers, if any. `inText`: focus is in an editable field.
 * A ⌃ chord is matched first, so where ⌘ is Ctrl (off macOS) ⌃1 still
 * switches accounts rather than tabs.
 */
export function matchChord(chords: Chord[], e: ChordEvent, inText: boolean): Chord | undefined {
  if (e.altKey) return undefined
  const key = e.key.toLowerCase()
  if (e.ctrlKey && !e.metaKey) {
    const c = chords.find((x) => x.ctrl && x.key.toLowerCase() === key && !!x.shift === e.shiftKey)
    if (c) return c
  }
  if (!(e.metaKey || e.ctrlKey)) return undefined
  // ⌘A in a text field selects its text, not every row behind it.
  if (inText && key === 'a') return undefined
  return chords.find((x) => !x.ctrl && x.key.toLowerCase() === key && !!x.shift === e.shiftKey)
}
```

- [x] **Step 5: Extend the registry.** In `src/ui/commands.ts`:
  - Add the `ctrl` key kind to `KeySpec`:

```ts
  /** The physical Control key plus a key (⌃1, ⌃Tab), on every platform. */
  | { kind: 'ctrl'; key: string; shift?: boolean; modes?: Mode[] }
```

  - Above `CommandId`, add:

```ts
export type Digit = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
export const DIGITS: Digit[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
```

  - Add `` | `account.${Digit}` `` to the `CommandId` union.
  - Add to `Command`:

```ts
  /**
   * How the shortcut sheet shows it: `false` hides it, an object replaces the
   * row. A numbered family (⌃1–⌃9) shows one row for all nine.
   */
  sheet?: false | { label: string; keys: string[] }
```

  - Append to `COMMANDS`, after `account.add`:

```ts
  ...DIGITS.map(
    (d): Command => ({
      id: `account.${d}`,
      title: `Switch to account ${d}`,
      group: 'General',
      keys: [{ kind: 'ctrl', key: d, modes: LIST_THREAD }],
      sheet: d === '1' ? { label: 'Switch to account 1–9', keys: ['⌃', '1–9'] } : false
    })
  ),
```

  - In `keyCaps`, before the `mod` line, add:

```ts
  if (spec.kind === 'ctrl') return ['⌃', ...(spec.shift ? ['⇧'] : []), cap(spec.key).toUpperCase()]
```

  - Give every builder the command list as its last parameter, defaulting to `COMMANDS`, and pass it through `live`:

```ts
function live(handlers: Handlers, commands: Command[] = COMMANDS): { cmd: Command; run: Handler }[] {
  return commands.flatMap((cmd) => {
    const run = handlers[cmd.id]
    return run && !cmd.external ? [{ cmd, run }] : []
  })
}

export function buildBindings(mode: Mode, handlers: Handlers, commands: Command[] = COMMANDS): Binding[] {
  return live(handlers, commands).flatMap(({ cmd, run }) =>
    cmd.keys.flatMap((k) =>
      k.kind === 'key' ? [{ key: k.key, modes: k.modes, handler: () => void run({ mode }) }] : []
    )
  )
}

export function buildChords(mode: Mode, handlers: Handlers, commands: Command[] = COMMANDS): Chord[] {
  return live(handlers, commands).flatMap(({ cmd, run }) =>
    cmd.keys.flatMap((k) =>
      (k.kind === 'mod' || k.kind === 'ctrl') && (!k.modes || k.modes.includes(mode))
        ? [{ key: k.key, shift: k.shift, ctrl: k.kind === 'ctrl' || undefined, handler: () => void run({ mode }) }]
        : []
    )
  )
}
```

    Do the same for `buildSequences(mode, handlers, commands = COMMANDS)` and `buildPaletteActions(mode, handlers, commands = COMMANDS)` (each calls `live(handlers, commands)`), and `shortcutGroups(commands: Command[] = COMMANDS)`.
  - In `shortcutGroups`, filter out `c.sheet === false` and let a `sheet` object replace the row:

```ts
export function shortcutGroups(commands: Command[] = COMMANDS): { title: Group; items: SheetRow[] }[] {
  return GROUP_ORDER.map((title) => ({
    title,
    items: commands
      .filter((c) => c.group === title && c.keys.length > 0 && c.sheet !== false)
      .map((c) =>
        c.sheet
          ? { label: c.sheet.label, keys: c.sheet.keys }
          : {
              label: c.title,
              keys: keyCaps(c.keys[0]),
              then: c.keys[0].kind === 'seq' || undefined,
              alt: c.keys[1] ? keyCaps(c.keys[1]) : undefined
            }
      )
  })).filter((g) => g.items.length > 0)
}
```

- [x] **Step 6: Create `src/ui/keymap.ts`.**

```ts
import { COMMANDS, keyCaps, type Command, type CommandId, type KeySpec } from './commands'
import { eventKey, MODES, type Mode } from './hooks/useHotkeys'

/** A user's replacement for a command's primary key. Sequences and ⌃ chords are not remappable. */
export type RemapSpec = { kind: 'key'; key: string } | { kind: 'mod'; key: string; shift?: boolean }
export type Keymap = Partial<Record<CommandId, RemapSpec>>

const IDS = new Set<string>(COMMANDS.map((c) => c.id))
const DEFAULT_KEY_MODES: Mode[] = ['list', 'thread']

/**
 * Compose-editor chords belong to the editor, sequences and numbered families
 * come as a set, and everything else can take a new single key or ⌘ chord.
 */
export function isRemappable(c: Command): boolean {
  if (c.external || c.sheet !== undefined) return false
  const k = c.keys[0]
  return !k || k.kind === 'key' || k.kind === 'mod'
}

/** settings.keymap, tolerating anything a hand edit or an old build left there. */
export function parseKeymap(json: string | null | undefined): Keymap {
  if (!json) return {}
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Keymap = {}
  for (const [id, spec] of Object.entries(raw as Record<string, unknown>)) {
    if (!IDS.has(id)) continue
    const s = spec as { kind?: unknown; key?: unknown; shift?: unknown } | null
    if (!s || typeof s.key !== 'string' || !s.key) continue
    if (s.kind === 'key') out[id as CommandId] = { kind: 'key', key: s.key }
    else if (s.kind === 'mod')
      out[id as CommandId] = { kind: 'mod', key: s.key, ...(s.shift === true ? { shift: true } : {}) }
  }
  return out
}

/**
 * Commands with each override in place of the primary key. The original
 * key's modes are kept, so a remapped list key stays a list key.
 */
export function applyKeymap(commands: Command[], map: Keymap): Command[] {
  return commands.map((c) => {
    const o = map[c.id]
    if (!o || !isRemappable(c)) return c
    const modes = c.keys[0]?.modes ?? (o.kind === 'key' ? DEFAULT_KEY_MODES : undefined)
    const primary: KeySpec = { ...o, ...(modes ? { modes } : {}) }
    return { ...c, keys: [primary, ...c.keys.slice(1)] }
  })
}

/** Every clash a keymap would create: one key for two commands in a mode, or a key that starts a g sequence. */
export function keymapConflicts(commands: Command[]): string[] {
  const out: string[] = []
  const seen = new Map<string, Command>()
  const prefixes = new Set(commands.flatMap((c) => c.keys.flatMap((k) => (k.kind === 'seq' ? [k.keys[0]] : []))))
  for (const c of commands) {
    for (const k of c.keys) {
      if (k.kind === 'seq') continue
      if (k.kind === 'key' && prefixes.has(k.key)) out.push(`${c.title}: ${k.key} starts a g sequence`)
      const name = k.kind === 'key' ? k.key : `${k.shift ? '⇧' : ''}${k.key.toLowerCase()}`
      for (const m of k.modes ?? MODES) {
        const slot = `${k.kind}:${m}:${name}`
        const prev = seen.get(slot)
        if (prev && prev.id !== c.id) out.push(`${prev.title} and ${c.title} both use ${keyCaps(k).join('')} (${m})`)
        else seen.set(slot, c)
      }
    }
  }
  return [...new Set(out)]
}

type KeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/** The key a press would bind, or null for a bare modifier, ⌥, ⌃-only, or Escape (which cancels recording). */
export function specFromEvent(e: KeyEvent): RemapSpec | null {
  if (['Shift', 'Meta', 'Control', 'Alt', 'CapsLock'].includes(e.key)) return null
  if (e.altKey || e.key === 'Escape') return null
  if (e.ctrlKey && !e.metaKey) return null
  if (e.metaKey) {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    return { kind: 'mod', key, ...(e.shiftKey ? { shift: true } : {}) }
  }
  return { kind: 'key', key: eventKey(e) }
}
```

- [x] **Step 7: Free ⌘W.** Create `electron/menu.ts`:

```ts
import { Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * Electron's default menu binds ⌘W to Close Window, which would swallow the
 * close-tab shortcut before the renderer sees it. Same menus otherwise; the
 * window closes with ⇧⌘W. The Window menu is spelled out because its role
 * adds Close (⌘W) off macOS.
 */
export function installAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [{ role: 'close', accelerator: 'Shift+CmdOrCtrl+W' }] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
```

  In `electron/main.ts`, import it (`import { installAppMenu } from './menu.js'`) and call `installAppMenu()` in `app.whenReady().then(...)` right after `boot()`.

- [x] **Step 8: Record shortcuts in Settings.** Create `src/ui/views/ShortcutSettings.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { COMMANDS, keyCaps, type CommandId } from '../commands'
import { applyKeymap, isRemappable, keymapConflicts, parseKeymap, specFromEvent, type Keymap } from '../keymap'

/** Remap a command's primary key. Reads and writes settings.keymap itself; App reloads it when Settings closes. */
export function ShortcutSettings() {
  const [map, setMap] = useState<Keymap>({})
  const [recording, setRecording] = useState<CommandId | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.getSettings().then((s) => setMap(parseKeymap(s.keymap)))
  }, [])

  const save = (next: Keymap): void => {
    setMap(next)
    void window.api.setSettings({ keymap: JSON.stringify(next) })
  }

  // Capture phase and stopImmediatePropagation: the recorded key must not also
  // run its current command (⌘K would open the palette over Settings).
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape') return setRecording(null)
      const spec = specFromEvent(e)
      if (!spec) return
      const next = { ...map, [recording]: spec }
      const clash = keymapConflicts(applyKeymap(COMMANDS, next))
      setRecording(null)
      if (clash.length) return setError(clash[0])
      setError(null)
      save(next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, map])

  const commands = applyKeymap(COMMANDS, map).filter(isRemappable)

  return (
    <section className="settings-section">
      <h3>Shortcuts</h3>
      {error && <p className="settings-error">{error}</p>}
      <ul className="shortcut-remap">
        {commands.map((c) => (
          <li key={c.id}>
            <span className="shortcut-remap-title">{c.title}</span>
            <span className="shortcut-remap-keys">
              {recording === c.id
                ? 'Press a key… (Esc to cancel)'
                : c.keys[0]
                  ? keyCaps(c.keys[0]).map((k, i) => <kbd key={i}>{k}</kbd>)
                  : '—'}
            </span>
            <button type="button" onClick={() => setRecording(c.id)}>
              Change
            </button>
            {map[c.id] && (
              <button
                type="button"
                onClick={() => {
                  const next = { ...map }
                  delete next[c.id]
                  save(next)
                }}
              >
                Reset
              </button>
            )}
          </li>
        ))}
      </ul>
      {Object.keys(map).length > 0 && (
        <button type="button" onClick={() => save({})}>
          Reset all shortcuts
        </button>
      )}
    </section>
  )
}
```

  In `src/ui/views/Settings.tsx`, import it and render `<ShortcutSettings />` right after `<TriageSettings />`.

  In `src/ui/views/ShortcutHelp.tsx`, delete the module-level `const GROUPS = shortcutGroups()`, change the props to `{ onClose: () => void; commands?: Command[] }` (import `type Command` from `'../commands'`), and compute `const groups = shortcutGroups(commands)` inside the component; render `groups` where `GROUPS` was.

  Append to `src/ui/styles/app.css`:

```css
.shortcut-remap { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; max-height: 280px; overflow: auto; }
.shortcut-remap li { display: grid; grid-template-columns: 1fr auto auto auto; gap: 8px; align-items: center; font-size: 12.5px; }
.shortcut-remap-keys kbd { font-family: inherit; padding: 1px 5px; border: 1px solid var(--border); border-radius: 4px; margin-left: 2px; }
.settings-error { color: var(--danger, #c33); font-size: 12px; margin: 0 0 6px; }
```

  (If `--border` or `--danger` do not exist in `src/ui/styles/tokens.css`, use the nearest existing border and error tokens from that file.)

- [x] **Step 9: Wire App.** In `src/ui/App.tsx`:
  - Imports: add `COMMANDS, DIGITS` to the `./commands` import; add `import { applyKeymap, parseKeymap, type Keymap } from './keymap'`.
  - State, near the other settings state: `const [keymap, setKeymap] = useState<Keymap>({})` and `const commands = useMemo(() => applyKeymap(COMMANDS, keymap), [keymap])`.
  - In the settings `useEffect` that reads `window.api.getSettings()` at mount, add `setKeymap(parseKeymap(s.keymap))`.
  - In the effect that reloads splits when `settingsOpen` turns false, add `void window.api.getSettings().then((s) => setKeymap(parseKeymap(s.keymap)))` before `listSplits()`.
  - Add, after `switchAccount`:

```ts
  /** ⌃1–⌃9: the nth account in sidebar order. */
  const switchToAccountAt = useCallback(
    (i: number) => {
      const a = accounts[i]
      if (a && a.accountId !== activeAccountId) void switchAccount(a.accountId)
    },
    [accounts, activeAccountId, switchAccount]
  )
```

  - Inside the `withTiming({ ... })` object, spread the account handlers:

```ts
        ...(Object.fromEntries(
          DIGITS.map((d, i) => [`account.${d}`, () => switchToAccountAt(i)])
        ) as Handlers),
```

    and add `switchToAccountAt` to the `handlers` dependency list.
  - Pass `commands` to every builder: `buildBindings(mode, handlers, commands)`, `buildChords(mode, handlers, commands)`, `buildSequences(mode, handlers, commands)`, `buildPaletteActions(paletteMode, handlers, commands)`, and add `commands` to those `useMemo` dependency lists.
  - Render `<ShortcutHelp onClose={() => setShortcutsOpen(false)} commands={commands} />`.
  - `src/ui/appMode.test.ts` reads `App.tsx` as text: change its expectation `'buildPaletteActions(paletteMode, handlers)'` to `'buildPaletteActions(paletteMode, handlers, commands)'`.

- [x] **Step 10: Run the tests, then the suite.** `pnpm exec vitest run src/ui` passes. `pnpm typecheck && pnpm test` green (**62 files**).

- [ ] **Step 11: Commit.**

```bash
git add src/ui electron/menu.ts electron/main.ts
git commit -m "[feat] control chords, account keys, remappable shortcuts; free cmd-w"
```

---
### Task 4: Unified inbox, with every read pinned to its account

**Files:**
- Create: `src/core/store/unified.ts`, `src/core/store/unified.test.ts`, `electron/ipcPower.ts`, `src/ui/accountGroups.ts`, `src/ui/accountGroups.test.ts`
- Modify: `src/core/store/listRows.ts`, `electron/ipc.ts`, `electron/main.ts`, `electron/preload.ts`, `src/ui/store.ts`, `src/ui/commands.ts`, `src/ui/commands.test.ts`, `src/ui/App.tsx`, `src/ui/views/Sidebar.tsx`, `src/ui/views/MessageList.tsx`, `src/ui/views/Thread.tsx`, `src/ui/views/Compose.tsx`, `src/ui/styles/app.css`

- [x] **Step 1: Write the failing tests.** Create `src/core/store/unified.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import { upsertMessage } from './repo.js'
import { countUnified, inboxScopes, listUnified, unifiedSplitCounts, unifiedUnread } from './unified.js'

let uid = 0
let inbox1: number
let inbox2: number
let archive1: number

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'unified-')), 't.db'))
  uid = 0
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (1,'a@x.test'),(2,'b@y.test')").run()
  const ins = db.prepare('INSERT INTO folders (account_id,path,name,role) VALUES (?,?,?,?)')
  inbox1 = Number(ins.run(1, 'INBOX', 'INBOX', 'inbox').lastInsertRowid)
  inbox2 = Number(ins.run(2, 'INBOX', 'INBOX', 'inbox').lastInsertRowid)
  archive1 = Number(ins.run(1, 'Archive', 'Archive', 'archive').lastInsertRowid)
})

function add(account: number, folder: number, thread: string, date: number, o: { seen?: boolean; from?: string } = {}): number {
  uid++
  return upsertMessage({
    account_id: account,
    folder_id: folder,
    uid,
    message_id: `<m${uid}@t>`,
    thread_id: thread,
    in_reply_to: null,
    from_addr: o.from ?? 'them@z.test',
    from_name: null,
    to_addrs: '[]',
    cc_addrs: '[]',
    subject: `s${uid}`,
    date,
    snippet: null,
    flags: JSON.stringify(o.seen ? ['\\Seen'] : [])
  })
}

describe('unified inbox', () => {
  it("lists every account's Inbox newest first, each row tagged with its own account", () => {
    add(1, inbox1, '<a@t>', 100)
    add(2, inbox2, '<b@t>', 200)
    add(1, archive1, '<c@t>', 300)
    const rows = listUnified(inboxScopes([1, 2]))
    expect(rows.map((r) => [r.subject, r.account_id])).toEqual([
      ['s2', 2],
      ['s1', 1]
    ])
  })

  it('keeps a thread id that two accounts share as two rows', () => {
    // The same mailing list delivered to both accounts: thread ids collide.
    add(1, inbox1, '<list@t>', 100)
    add(2, inbox2, '<list@t>', 150)
    const rows = listUnified(inboxScopes([1, 2]))
    expect(rows.map((r) => r.account_id).sort()).toEqual([1, 2])
    expect(rows.every((r) => r.thread_count === 1)).toBe(true)
  })

  it('reads only the accounts it is given, and skips one with no Inbox yet', () => {
    add(1, inbox1, '<a@t>', 100)
    add(2, inbox2, '<b@t>', 200)
    expect(inboxScopes([1, 99])).toEqual([{ accountId: 1, folderId: inbox1 }])
    expect(listUnified(inboxScopes([1])).map((r) => r.account_id)).toEqual([1])
    expect(listUnified([])).toEqual([])
  })

  it('applies list queries per owning account (VIP is per account)', () => {
    add(1, inbox1, '<a@t>', 100, { from: 'boss@z.test' })
    add(2, inbox2, '<b@t>', 200, { from: 'boss@z.test' })
    getDb().prepare("INSERT INTO vip_senders (account_id, address) VALUES (1, 'boss@z.test')").run()
    const scopes = inboxScopes([1, 2])
    expect(listUnified(scopes, { query: 'is:vip' }).map((r) => r.account_id)).toEqual([1])
    expect(countUnified(scopes, { query: 'is:vip' })).toBe(1)
  })

  it('counts, pages, sums unread and counts splits like the list', () => {
    add(1, inbox1, '<a@t>', 100)
    add(2, inbox2, '<b@t>', 200, { seen: true })
    add(2, inbox2, '<c@t>', 300)
    const scopes = inboxScopes([1, 2])
    expect(countUnified(scopes)).toBe(3)
    expect(listUnified(scopes, { limit: 1, offset: 1 }).map((r) => r.subject)).toEqual(['s2'])
    expect(unifiedUnread(scopes)).toBe(2)
    expect(unifiedSplitCounts(scopes, 'is:unread').all).toBe(2)
  })
})
```

  Create `src/ui/accountGroups.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { threadsByAccount } from './accountGroups.js'

describe('threadsByAccount', () => {
  it('groups thread ids under the account that owns each row, once each', () => {
    const rows = [
      { thread_id: '<a>', account_id: 1 },
      { thread_id: '<list>', account_id: 2 },
      { thread_id: '<list>', account_id: 1 },
      { thread_id: '<a>', account_id: 1 },
      { thread_id: null, account_id: 2 }
    ]
    expect([...threadsByAccount(rows)]).toEqual([
      [1, ['<a>', '<list>']],
      [2, ['<list>']]
    ])
  })
})
```

  In `src/ui/commands.test.ts`, add:

```ts
  it('binds g a to the unified inbox', () => {
    expect(Object.keys(buildSequences('list', { 'go.unified': () => {} }).g ?? {})).toEqual(['a'])
  })
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/core/store/unified.test.ts src/ui/accountGroups.test.ts src/ui/commands.test.ts`. Expected: FAIL (missing modules; no `go.unified`).

- [x] **Step 3: Share the list columns.** In `src/core/store/listRows.ts`, replace the `M_COLS` constant with an exported one that also carries the rollup, and use it in `listView`:

```ts
const M_COLS = LIST_COLS.split(', ')
  .map((c) => `m.${c}`)
  .join(', ')

/** What a list row selects: the newest message's columns plus the thread rollup. */
export const LIST_ROW_COLS = `${M_COLS}, lr.msg_count AS thread_count, lr.unread_count AS thread_unread,
              lr.reminder_fired AS reminder_fired, lr.sort_date AS sort_date`
```

  and in `listView` change the select list to `SELECT ${LIST_ROW_COLS}`.

- [x] **Step 4: Create `src/core/store/unified.ts`.**

```ts
import { getDb } from './db.js'
import { folderByRole } from './repo.js'
import { LIST_ROW_COLS, refreshListRows, type ListViewOptions } from './listRows.js'
import { listWhere } from './search.js'
import { listSplits } from './splits.js'
import type { MessageListRow } from './types.js'

/** One account's Inbox. The unified view is a list of these. */
export interface InboxScope {
  accountId: number
  folderId: number
}

/** Each account's Inbox. An account whose first sync has not found one yet is skipped. */
export function inboxScopes(accountIds: number[]): InboxScope[] {
  return accountIds.flatMap((accountId) => {
    const f = folderByRole(accountId, 'inbox')
    return f ? [{ accountId, folderId: f.id }] : []
  })
}

/**
 * Pins every row to its owner: `(lr.account_id = ? AND lr.folder_id = ?) OR …`.
 * thread ids collide across accounts, so no read may match on folder or
 * thread alone.
 */
function scopeWhere(scopes: InboxScope[]): { sql: string; params: number[] } {
  return {
    sql: `(${scopes.map(() => '(lr.account_id = ? AND lr.folder_id = ?)').join(' OR ')})`,
    params: scopes.flatMap((s) => [s.accountId, s.folderId])
  }
}

/** One page across every Inbox, newest conversation first. Hidden rows are left out, as in listView. */
export function listUnified(scopes: InboxScope[], opts: ListViewOptions = {}): MessageListRow[] {
  if (!scopes.length) return []
  refreshListRows()
  const s = scopeWhere(scopes)
  const w = listWhere(opts.query ?? '')
  return getDb()
    .prepare(
      `SELECT ${LIST_ROW_COLS}
         FROM list_rows lr JOIN messages m ON m.id = lr.newest_id AND m.account_id = lr.account_id
        WHERE ${s.sql} AND lr.hidden = 0${w.sql}
        ORDER BY lr.sort_date DESC, lr.newest_id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...s.params, ...w.params, opts.limit ?? 100, opts.offset ?? 0) as MessageListRow[]
}

/** Conversations behind the unified view, for the pager. Mirrors listUnified's WHERE. */
export function countUnified(scopes: InboxScope[], opts: { query?: string } = {}): number {
  if (!scopes.length) return 0
  refreshListRows()
  const s = scopeWhere(scopes)
  const w = listWhere(opts.query ?? '')
  return (
    getDb()
      .prepare(
        `SELECT count(*) AS c
           FROM list_rows lr JOIN messages m ON m.id = lr.newest_id AND m.account_id = lr.account_id
          WHERE ${s.sql} AND lr.hidden = 0${w.sql}`
      )
      .get(...s.params, ...w.params) as { c: number }
  ).c
}

/** Unread across every Inbox, for the sidebar badge. Hidden rows do not count. */
export function unifiedUnread(scopes: InboxScope[]): number {
  if (!scopes.length) return 0
  refreshListRows()
  const s = scopeWhere(scopes)
  return (
    getDb()
      .prepare(`SELECT COALESCE(SUM(lr.unread_count), 0) AS c FROM list_rows lr WHERE ${s.sql} AND lr.hidden = 0`)
      .get(...s.params) as { c: number }
  ).c
}

/** Per-split counts for the unified view, with the active chip ANDed on. */
export function unifiedSplitCounts(scopes: InboxScope[], extraQuery = ''): Record<string, number> {
  return Object.fromEntries(
    listSplits().map((sp) => [sp.id, countUnified(scopes, { query: `${sp.query} ${extraQuery}`.trim() })])
  )
}
```

- [x] **Step 5: Create `src/ui/accountGroups.ts`.**

```ts
/**
 * Thread ids per owning account, first-seen order, each once. Read/unread
 * IPC takes one account per call, and in the unified view one selection can
 * span accounts whose thread ids collide.
 */
export function threadsByAccount(
  rows: { thread_id: string | null; account_id: number }[]
): Map<number, string[]> {
  const out = new Map<number, string[]>()
  for (const r of rows) {
    if (!r.thread_id) continue
    const list = out.get(r.account_id) ?? []
    if (!list.includes(r.thread_id)) list.push(r.thread_id)
    out.set(r.account_id, list)
  }
  return out
}
```

- [x] **Step 6: Main — account-scoped thread and compose calls.** In `electron/ipc.ts`:
  - Under `ownerOf`, add:

```ts
/** The account a renderer call names, or the active one when it names none. */
function accountFor(accountId?: number | null): LiveAccount | null {
  if (accountId != null) return getAccount(accountId)
  const s = getBootState()
  return s.ok ? getAccount(s.accountId) : null
}
```

  - Replace the `thread:get`, `thread:markUnread` and `thread:markRead` handlers:

```ts
  // Thread ids collide across accounts, so the caller says whose thread it is
  // (the row's account_id); the active account is only the default.
  ipcMain.handle('thread:get', (_e, threadId: string, accountId?: number) => {
    const a = accountFor(accountId)
    return a ? getThread(a.accountId, threadId) : []
  })

  /**
   * Whole-thread, mirroring markRead: reading marks every message seen, so
   * un-reading only the newest would be undone the moment it reopens.
   */
  ipcMain.handle('thread:markUnread', (_e, threadIds: string[], accountId?: number) => {
    const a = accountFor(accountId)
    if (!a) return { ok: false as const, error: 'account not found' }
    const writer = flagWriterFor(a.accountId, a.config)
    const changed: number[] = []
    for (const threadId of threadIds) {
      for (const m of getThread(a.accountId, threadId)) {
        const next = removeFlag(m.id, '\\Seen')
        if (!next) continue
        changed.push(m.id)
        writer.enqueue({ messageId: m.id, flag: '\\Seen', add: false })
      }
    }
    return { ok: true as const, changed }
  })

  ipcMain.handle('thread:markRead', (_e, threadId: string, accountId?: number) => {
    const a = accountFor(accountId)
    if (!a) return { ok: false as const, error: 'account not found' }
    const writer = flagWriterFor(a.accountId, a.config)
    const changed: number[] = []
    for (const m of getThread(a.accountId, threadId)) {
      const next = addFlag(m.id, '\\Seen')
      if (next) {
        changed.push(m.id)
        writer.enqueue({ messageId: m.id, flag: '\\Seen', add: true })
      }
    }
    return { ok: true as const, changed }
  })
```

  - In `compose:saveDraft`, replace `const s = getBootState()` / `if (!s.ok) ...` with `const a = accountFor(payload.accountId)` / `if (!a) return { ok: false as const, error: 'account not found' }`, and use `account_id: a.accountId, from_addr: a.config.email` in `createDraft`.
  - In `compose:queueSend`, do the same and use `account_id: a.accountId` in `enqueueOutbox`. A reply from the unified inbox must leave from the account that received the mail.
  - After `ipcMain.handle('sync:run', ...)`, add:

```ts
  // The unified inbox shows every account, so its refresh syncs every account.
  ipcMain.handle('sync:runAll', async () => {
    let folders = 0
    let messages = 0
    const errors: unknown[] = []
    for (const a of listAccounts()) {
      const r = await runSyncFor({ ok: true, accountId: a.accountId, email: a.email, config: a.config })
      if (!r.ok) return r
      // Another pass already holds this account (timer, focus): not a failure.
      if (r.skipped) continue
      folders += r.folders
      messages += r.messages
      errors.push(...r.errors)
    }
    return { ok: true as const, folders, messages, errors, skipped: false }
  })
```

    Add `listAccounts` to the `./state.js` import.

- [x] **Step 7: Create `electron/ipcPower.ts`** and register it.

```ts
import { ipcMain } from 'electron'
import {
  countUnified,
  inboxScopes,
  listUnified,
  unifiedSplitCounts,
  unifiedUnread
} from '../src/core/store/unified.js'
import { listAccounts } from './state.js'

/** Every connected account's Inbox, in sidebar order. */
const scopes = () => inboxScopes(listAccounts().map((a) => a.accountId))

/**
 * Phase 3 handlers (unified inbox, snippets, search page, contact pane). Kept
 * out of ipc.ts, which owns sync, compose and the move hold.
 */
export function registerPowerIpc(): void {
  ipcMain.handle('unified:list', (_e, limit = 50, offset = 0, query = '') =>
    listUnified(scopes(), { limit, offset, query })
  )
  ipcMain.handle('unified:count', (_e, query = '') => countUnified(scopes(), { query }))
  ipcMain.handle('unified:splitCounts', (_e, extraQuery = '') => unifiedSplitCounts(scopes(), extraQuery))
  ipcMain.handle('unified:unread', () => unifiedUnread(scopes()))
}
```

  In `electron/main.ts`, import it and call `registerPowerIpc()` after `registerTriageIpc()`.

- [x] **Step 8: Preload.** In `electron/preload.ts`:
  - Add `accountId?: number | null` to `DraftPayload` (so `QueueSendPayload` inherits it).
  - Change `getThread`, `markThreadRead` and `markThreadsUnread` to take a trailing `accountId?: number` and pass it to `ipcRenderer.invoke` as the last argument.
  - Add:

```ts
  listUnified: (limit?: number, offset?: number, query?: string): Promise<MessageListRow[]> =>
    ipcRenderer.invoke('unified:list', limit, offset, query),
  countUnified: (query?: string): Promise<number> => ipcRenderer.invoke('unified:count', query),
  unifiedSplitCounts: (extraQuery?: string): Promise<Record<string, number>> =>
    ipcRenderer.invoke('unified:splitCounts', extraQuery),
  unifiedUnread: (): Promise<number> => ipcRenderer.invoke('unified:unread'),
  runSyncAll: (): Promise<SyncRunResult> => ipcRenderer.invoke('sync:runAll'),
```

- [x] **Step 9: Registry and store.**
  - `src/ui/commands.ts`: add `'go.unified'` to `CommandId`, and after `go.inbox`:

```ts
  { id: 'go.unified', title: 'Go to All inboxes', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 'a'], modes: ['list'] }] },
```

  - `src/ui/store.ts`:
    - Add `export const UNIFIED_VIEW_ID = -2` under `REMINDERS_VIEW_ID`, with the comment `/** activeFolderId sentinel for All inboxes: every account's Inbox (needs two or more accounts). */`.
    - `openThread` becomes `{ threadId: string; messageId: number; accountId?: number } | null`; `openThreadView: (threadId: string, messageId: number, accountId?: number) => void`, implemented as `set({ openThread: { threadId, messageId, accountId } })`.
    - `ComposeState` gains `/** The account it sends from; null = the active one. */ accountId: number | null`; `emptyCompose()` returns `accountId: null`.

- [x] **Step 10: App.** In `src/ui/App.tsx` (import `UNIFIED_VIEW_ID` from `./store` and `threadsByAccount` from `./accountGroups`):
  - `isInbox`: `(fid) => fid === UNIFIED_VIEW_ID || useStore.getState().folders.find((f) => f.id === fid)?.role === 'inbox'`.
  - `refreshSplitCounts`: replace its read with

```ts
      const extra = viewQuery('', useStore.getState().chip)
      await splitCountsRead.current(() =>
        folderId === UNIFIED_VIEW_ID ? window.api.unifiedSplitCounts(extra) : window.api.splitCounts(folderId, extra)
      )
```
  - `fetchPage`: after the Reminders line, add `if (folderId === UNIFIED_VIEW_ID) return window.api.listUnified(PAGE_SIZE, offset, currentQuery(folderId))` (compute `offset` first).
  - `loadRows` and `goToPage`: where they call `window.api.countMessages(folderId, currentQuery(folderId))`, call `window.api.countUnified(currentQuery(folderId))` for `UNIFIED_VIEW_ID`. In `goToPage`, only reach for `loadOlder` when `folderId > 0` (replace the `folderId !== REMINDERS_VIEW_ID` check).
  - `refreshUnread`: also store the unified total under its sentinel: `setUnread({ ...(await window.api.unreadCounts()), [UNIFIED_VIEW_ID]: await window.api.unifiedUnread() })`.
  - `backgroundSync`: call `before.activeFolderId === UNIFIED_VIEW_ID ? window.api.runSyncAll() : window.api.runSync()`.
  - `openThreadAndRead(threadId, messageId, accountId?: number)`: call `openThreadView(threadId, messageId, accountId)` and `window.api.markThreadRead(threadId, accountId)`.
  - `openRow`: `openThreadAndRead(row.thread_id, row.id, row.account_id)`.
  - `setThreadsRead`: group the targets by account:

```ts
      const groups = threadsByAccount(targets)
      if (!groups.size) return
      for (const [accountId, threadIds] of groups) {
        if (read) {
          for (const threadId of threadIds) {
            const res = await window.api.markThreadRead(threadId, accountId)
            if (!res.ok) return setActionError(res.error)
            for (const id of res.changed) markRowSeen(id)
          }
        } else {
          const res = await window.api.markThreadsUnread(threadIds, accountId)
          if (!res.ok) return setActionError(res.error)
        }
      }
```

  - `unreadFromThread`: `window.api.markThreadsUnread([ot.threadId], ot.accountId)`.
  - `openDraft`, `startReply`, `startForward`: add `accountId: msg.account_id` to the `openCompose({...})` object.
  - `'go.unified'` handler: `() => { if (accounts.length > 1) void onFolder(UNIFIED_VIEW_ID) }`.
  - `'triage.zero'`: before the existing check add `if (fid === UNIFIED_VIEW_ID) return setActionError('Get me to zero works on one account’s Inbox')`.
  - Header title: `activeFolderId === UNIFIED_VIEW_ID ? 'All inboxes' : activeFolderId === REMINDERS_VIEW_ID ? 'Reminders' : …`.
  - SplitBar: render when `(active && active.role !== 'drafts') || activeFolderId === UNIFIED_VIEW_ID`, with `splits={active?.role === 'inbox' || activeFolderId === UNIFIED_VIEW_ID ? splits : null}`.
  - Empty-state and zero-state checks that test `active?.role === 'inbox'` also accept `activeFolderId === UNIFIED_VIEW_ID`.
  - `<Thread … accountId={openThread.accountId} />` and `<Compose … />` unchanged (Compose reads `compose.accountId`).
  - `<MessageList … accountLabel={activeFolderId === UNIFIED_VIEW_ID ? (id) => accounts.find((a) => a.accountId === id)?.email : undefined} />`.
  - `<Sidebar … showUnified={accounts.length > 1} />`.

- [x] **Step 11: Views.**
  - `src/ui/views/Thread.tsx`: add `accountId?: number` to `Props`; call `window.api.getThread(threadId, accountId)` and add `accountId` to that effect's dependency list.
  - `src/ui/views/Compose.tsx`: pass `accountId: compose.accountId` in both the `saveDraft` and `queueSend` payloads.
  - `src/ui/views/MessageList.tsx`: add the prop `/** All inboxes: which account a row belongs to. */ accountLabel?: (accountId: number) => string | undefined`, and render `{accountLabel && <span className="row-account">{accountLabel(r.account_id)}</span>}` immediately before the `row-subject` span.
  - `src/ui/views/Sidebar.tsx`: add `showUnified?: boolean` to `Props` and, as the first `<li>` of `folder-list`:

```tsx
        {showUnified && (
          <li>
            <button
              className="folder-item"
              aria-current={activeFolderId === UNIFIED_VIEW_ID}
              onClick={(e) => {
                e.currentTarget.blur()
                onSelect(UNIFIED_VIEW_ID)
              }}
            >
              <Inbox className="folder-icon" size={15} strokeWidth={1.75} />
              <span className="folder-name">All inboxes</span>
              {(unread?.[UNIFIED_VIEW_ID] ?? 0) > 0 && (
                <span className="folder-count">{unread?.[UNIFIED_VIEW_ID]}</span>
              )}
            </button>
          </li>
        )}
```

    (import `Inbox` from `lucide-react` and `UNIFIED_VIEW_ID` from `'../store'`).
  - Append to `src/ui/styles/app.css`:

```css
.row-account { flex: none; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-muted); margin-right: 8px; }
```

    (use the muted-text token `tokens.css` actually defines if it is not `--text-muted`).

- [x] **Step 12: Run the tests, then the suite.** `pnpm exec vitest run src/core/store/unified.test.ts src/ui` passes. `pnpm typecheck && pnpm test` green (**64 files**).

- [ ] **Step 13: Commit.**

```bash
git add src electron
git commit -m "[feat] unified inbox; thread and compose calls act on the row's account"
```

---

### Task 5: Workspace tabs and per-tab history

**Files:**
- Create: `src/ui/workspace.ts`, `src/ui/workspace.test.ts`, `src/ui/views/TabBar.tsx`
- Modify: `src/ui/commands.ts`, `src/ui/commands.test.ts`, `src/ui/App.tsx`, `src/ui/styles/app.css`

- [x] **Step 1: Write the failing tests.** Create `src/ui/workspace.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  back,
  canGoBack,
  canGoForward,
  closeTab,
  currentView,
  cycleTab,
  forward,
  initWorkspace,
  MAX_HISTORY,
  MAX_TABS,
  navigate,
  openTab,
  record,
  restoreWorkspace,
  selectTab,
  serializeWorkspace,
  type View
} from './workspace.js'

const list = (folderId: number): View => ({ folderId, splitId: 'all', chip: null, thread: null })
const thread = (folderId: number, threadId: string): View => ({
  ...list(folderId),
  thread: { threadId, messageId: 1, accountId: 1 }
})

describe('history', () => {
  it('goes back and forward, and a new step drops the forward entries', () => {
    let ws = initWorkspace(list(1))
    ws = navigate(ws, thread(1, '<a>'))
    ws = navigate(ws, list(2))
    ws = back(ws)!
    expect(currentView(ws)).toEqual(thread(1, '<a>'))
    expect([canGoBack(ws), canGoForward(ws)]).toEqual([true, true])
    ws = navigate(ws, list(3))
    expect(canGoForward(ws)).toBe(false)
    expect(back(back(ws)!)).not.toBeNull()
    expect(forward(ws)).toBeNull()
  })

  it('ignores a step to the view already on screen', () => {
    const ws = initWorkspace(list(1))
    expect(navigate(ws, list(1))).toBe(ws)
    // A newer message in the same thread is still the same place.
    const t = navigate(ws, thread(1, '<a>'))
    expect(navigate(t, { ...thread(1, '<a>'), thread: { threadId: '<a>', messageId: 9, accountId: 1 } })).toBe(t)
  })

  it('keeps at most MAX_HISTORY entries per tab', () => {
    let ws = initWorkspace(list(0))
    for (let i = 1; i <= MAX_HISTORY + 5; i++) ws = navigate(ws, list(i))
    expect(ws.tabs[0].history).toHaveLength(MAX_HISTORY)
    expect(currentView(ws)).toEqual(list(MAX_HISTORY + 5))
  })

  it('records a search-query edit in place instead of as a new step', () => {
    const search = (query: string): View => ({ ...list(-3), query })
    let ws = initWorkspace(list(1))
    ws = record(ws, search('in'))
    ws = record(ws, search('invoice'))
    expect(ws.tabs[0].history).toEqual([list(1), search('invoice')])
    ws = record(ws, list(2))
    expect(ws.tabs[0].history).toHaveLength(3)
  })
})

describe('tabs', () => {
  it('opens a tab after the active one and switches to it', () => {
    let ws = initWorkspace(list(1))
    ws = openTab(ws, list(2))
    ws = selectTab(ws, 0)
    ws = openTab(ws, list(3))
    expect(ws.tabs.map((t) => currentView({ ...ws, active: ws.tabs.indexOf(t) }).folderId)).toEqual([1, 3, 2])
    expect(ws.active).toBe(1)
    expect(new Set(ws.tabs.map((t) => t.id)).size).toBe(3)
  })

  it('keeps each tab its own history', () => {
    let ws = initWorkspace(list(1))
    ws = navigate(ws, list(2))
    ws = openTab(ws, list(5))
    expect(canGoBack(ws)).toBe(false)
    ws = selectTab(ws, 0)
    expect(currentView(back(ws)!)).toEqual(list(1))
  })

  it('stops at MAX_TABS', () => {
    let ws = initWorkspace(list(0))
    for (let i = 1; i < MAX_TABS + 3; i++) ws = openTab(ws, list(i))
    expect(ws.tabs).toHaveLength(MAX_TABS)
  })

  it('closes a tab and lands on its right neighbour, or the new last tab', () => {
    let ws = initWorkspace(list(1))
    ws = openTab(ws, list(2))
    ws = openTab(ws, list(3))
    ws = selectTab(ws, 1)
    let next = closeTab(ws)!
    expect(currentView(next).folderId).toBe(3)
    next = closeTab(selectTab(ws, 2))!
    expect(currentView(next).folderId).toBe(2)
    // Closing a tab left of the active one keeps the same tab active.
    next = closeTab(selectTab(ws, 2), 0)!
    expect(currentView(next).folderId).toBe(3)
    expect(closeTab(initWorkspace(list(1)))).toBeNull()
  })

  it('selects by number with ⌘9 as the last tab, and cycles both ways', () => {
    let ws = initWorkspace(list(1))
    ws = openTab(ws, list(2))
    ws = openTab(ws, list(3))
    expect(selectTab(ws, 0).active).toBe(0)
    expect(selectTab(ws, 8).active).toBe(2)
    expect(selectTab(ws, 5)).toBe(ws)
    expect(cycleTab(ws, 1).active).toBe(0)
    expect(cycleTab(selectTab(ws, 0), -1).active).toBe(2)
  })
})

describe('persistence', () => {
  it('round-trips, dropping views that no longer exist', () => {
    let ws = initWorkspace(list(1))
    ws = navigate(ws, list(2))
    ws = openTab(ws, list(7))
    const json = serializeWorkspace(ws)
    const back1 = restoreWorkspace(json, (v) => v.folderId !== 7, list(1))
    expect(back1.tabs).toHaveLength(1)
    expect(back1.tabs[0].history).toEqual([list(1), list(2)])
    expect(back1.active).toBe(0)
    expect(restoreWorkspace(json, () => true, list(1))).toEqual(ws)
  })

  it('falls back to one tab on the fallback view for missing or corrupt data', () => {
    expect(restoreWorkspace(undefined, () => true, list(4))).toEqual(initWorkspace(list(4)))
    expect(restoreWorkspace('{"tabs":5}', () => true, list(4))).toEqual(initWorkspace(list(4)))
    expect(restoreWorkspace('nope', () => true, list(4))).toEqual(initWorkspace(list(4)))
  })
})
```

  In `src/ui/commands.test.ts`, add:

```ts
  it('binds tab and history chords in the list and a thread, not while composing', () => {
    const h = {
      'tab.new': () => {},
      'tab.close': () => {},
      'tab.next': () => {},
      'tab.prev': () => {},
      'tab.1': () => {},
      'tab.9': () => {},
      'history.back': () => {},
      'history.forward': () => {}
    } as Handlers
    expect(buildChords('thread', h).map((c) => [c.key, !!c.shift, !!c.ctrl])).toEqual([
      ['t', false, false],
      ['w', false, false],
      ['Tab', false, true],
      ['Tab', true, true],
      ['1', false, false],
      ['9', false, false],
      ['[', false, false],
      [']', false, false]
    ])
    expect(buildChords('compose', h)).toEqual([])
    const tabs = shortcutGroups().find((g) => g.title === 'Tabs')!
    expect(tabs.items.find((i) => i.label === 'Go to tab 1–9')).toEqual({ label: 'Go to tab 1–9', keys: ['⌘', '1–9'] })
  })
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/ui/workspace.test.ts src/ui/commands.test.ts`. Expected: FAIL (missing module; no tab commands).

- [x] **Step 3: Create `src/ui/workspace.ts`.**

```ts
import type { ChipId } from './chips'

/**
 * What one tab shows: a folder or special view (folderId is a folder id, or a
 * negative *_VIEW_ID sentinel), the split and chip on it, an optional open
 * thread, and the search page's query.
 */
export interface View {
  folderId: number
  splitId: string
  chip: ChipId | null
  thread: { threadId: string; messageId: number; accountId?: number } | null
  query?: string
}

/** history[index] is on screen; entries after it are "forward". */
export interface Tab {
  id: number
  history: View[]
  index: number
}

export interface Workspace {
  tabs: Tab[]
  active: number
  nextId: number
}

/** ⌘1–⌘9 reach every tab. */
export const MAX_TABS = 9
export const MAX_HISTORY = 50

/** Same place on screen. A thread is the same place whichever of its messages is focused. */
export function sameView(a: View, b: View): boolean {
  return (
    a.folderId === b.folderId &&
    a.splitId === b.splitId &&
    a.chip === b.chip &&
    (a.query ?? '') === (b.query ?? '') &&
    (a.thread?.threadId ?? null) === (b.thread?.threadId ?? null) &&
    (a.thread?.accountId ?? null) === (b.thread?.accountId ?? null)
  )
}

export function initWorkspace(view: View): Workspace {
  return { tabs: [{ id: 1, history: [view], index: 0 }], active: 0, nextId: 2 }
}

export function currentView(ws: Workspace): View {
  const t = ws.tabs[ws.active]
  return t.history[t.index]
}

function withTab(ws: Workspace, tab: Tab): Workspace {
  const tabs = ws.tabs.slice()
  tabs[ws.active] = tab
  return { ...ws, tabs }
}

/** A step to a new place: drops forward entries. Returns `ws` itself when nothing changed. */
export function navigate(ws: Workspace, view: View): Workspace {
  const t = ws.tabs[ws.active]
  if (sameView(t.history[t.index], view)) return ws
  const history = [...t.history.slice(0, t.index + 1), view].slice(-MAX_HISTORY)
  return withTab(ws, { ...t, history, index: history.length - 1 })
}

/** Rewrites the current entry without adding a step. */
export function replaceCurrent(ws: Workspace, view: View): Workspace {
  const t = ws.tabs[ws.active]
  const history = t.history.slice()
  history[t.index] = view
  return withTab(ws, { ...t, history })
}

/**
 * What App calls after any navigation. Typing in the search page changes only
 * the query, which edits the current entry; anything else is a step.
 */
export function record(ws: Workspace, view: View): Workspace {
  const cur = currentView(ws)
  const queryOnly =
    cur.folderId === view.folderId &&
    cur.thread === null &&
    view.thread === null &&
    (cur.query ?? '') !== (view.query ?? '') &&
    sameView({ ...cur, query: view.query }, view)
  return queryOnly ? replaceCurrent(ws, view) : navigate(ws, view)
}

export function canGoBack(ws: Workspace): boolean {
  return ws.tabs[ws.active].index > 0
}

export function canGoForward(ws: Workspace): boolean {
  const t = ws.tabs[ws.active]
  return t.index < t.history.length - 1
}

export function back(ws: Workspace): Workspace | null {
  const t = ws.tabs[ws.active]
  return t.index > 0 ? withTab(ws, { ...t, index: t.index - 1 }) : null
}

export function forward(ws: Workspace): Workspace | null {
  const t = ws.tabs[ws.active]
  return t.index < t.history.length - 1 ? withTab(ws, { ...t, index: t.index + 1 }) : null
}

/** A new tab right after the active one, made active. At MAX_TABS nothing happens. */
export function openTab(ws: Workspace, view: View): Workspace {
  if (ws.tabs.length >= MAX_TABS) return ws
  const tab: Tab = { id: ws.nextId, history: [view], index: 0 }
  const tabs = [...ws.tabs.slice(0, ws.active + 1), tab, ...ws.tabs.slice(ws.active + 1)]
  return { tabs, active: ws.active + 1, nextId: ws.nextId + 1 }
}

/** Null when it is the last tab: there is always one. */
export function closeTab(ws: Workspace, index = ws.active): Workspace | null {
  if (ws.tabs.length <= 1 || index < 0 || index >= ws.tabs.length) return null
  const tabs = ws.tabs.filter((_, i) => i !== index)
  const active =
    index < ws.active ? ws.active - 1 : index === ws.active ? Math.min(index, tabs.length - 1) : ws.active
  return { ...ws, tabs, active }
}

/** ⌘1–⌘8 pick that tab; ⌘9 (index 8) is always the last one, as in a browser. */
export function selectTab(ws: Workspace, index: number): Workspace {
  const i = index >= 8 ? ws.tabs.length - 1 : index
  if (i < 0 || i >= ws.tabs.length || i === ws.active) return ws
  return { ...ws, active: i }
}

export function cycleTab(ws: Workspace, delta: number): Workspace {
  const n = ws.tabs.length
  return n < 2 ? ws : { ...ws, active: (ws.active + delta + n) % n }
}

export function serializeWorkspace(ws: Workspace): string {
  return JSON.stringify(ws)
}

function isView(v: unknown): v is View {
  const x = v as View | null
  if (!x || typeof x.folderId !== 'number' || typeof x.splitId !== 'string') return false
  if (x.chip !== null && typeof x.chip !== 'string') return false
  if (x.query !== undefined && typeof x.query !== 'string') return false
  const t = x.thread
  return t === null || (!!t && typeof t.threadId === 'string' && typeof t.messageId === 'number')
}

/**
 * settings.workspace, keeping only views `valid` accepts (a folder may be gone,
 * or belong to another account after a switch). Anything unusable yields one
 * tab on `fallback`.
 */
export function restoreWorkspace(json: string | undefined, valid: (v: View) => boolean, fallback: View): Workspace {
  let raw: unknown
  try {
    raw = json ? JSON.parse(json) : null
  } catch {
    raw = null
  }
  const src = raw as Partial<Workspace> | null
  if (!src || !Array.isArray(src.tabs)) return initWorkspace(fallback)
  const tabs: Tab[] = []
  let active = 0
  src.tabs.forEach((t, i) => {
    if (!t || typeof t.id !== 'number' || !Array.isArray(t.history)) return
    const history = t.history.filter((v) => isView(v) && valid(v))
    if (!history.length) return
    const index = Math.max(0, Math.min(typeof t.index === 'number' ? t.index : 0, history.length - 1))
    if (i === src.active) active = tabs.length
    tabs.push({ id: t.id, history, index })
  })
  if (!tabs.length) return initWorkspace(fallback)
  const nextId = Math.max(...tabs.map((t) => t.id)) + 1
  return { tabs: tabs.slice(0, MAX_TABS), active: Math.min(active, tabs.length - 1), nextId }
}
```

- [x] **Step 4: Register the commands.** In `src/ui/commands.ts`:
  - Add `'Tabs'` to the `Group` union and to `GROUP_ORDER` right after `'Navigation'`.
  - Add to `CommandId`: `| 'tab.new' | 'tab.close' | 'tab.next' | 'tab.prev' | 'history.back' | 'history.forward'` and `` | `tab.${Digit}` ``.
  - Under `LIST_THREAD`, add:

```ts
/** Where tab and history chords work. The search page joins in Task 11. */
const NAV_MODES: Mode[] = ['list', 'thread']
```

  - Append to `COMMANDS` after the Navigation entries:

```ts
  { id: 'tab.new', title: 'New tab', group: 'Tabs', palette: true, keys: [{ kind: 'mod', key: 't', modes: NAV_MODES }] },
  { id: 'tab.close', title: 'Close tab', group: 'Tabs', palette: true, keys: [{ kind: 'mod', key: 'w', modes: NAV_MODES }] },
  { id: 'tab.next', title: 'Next tab', group: 'Tabs', keys: [{ kind: 'ctrl', key: 'Tab', modes: NAV_MODES }] },
  { id: 'tab.prev', title: 'Previous tab', group: 'Tabs', keys: [{ kind: 'ctrl', key: 'Tab', shift: true, modes: NAV_MODES }] },
  ...DIGITS.map(
    (d): Command => ({
      id: `tab.${d}`,
      title: d === '9' ? 'Go to last tab' : `Go to tab ${d}`,
      group: 'Tabs',
      keys: [{ kind: 'mod', key: d, modes: NAV_MODES }],
      sheet: d === '1' ? { label: 'Go to tab 1–9', keys: ['⌘', '1–9'] } : false
    })
  ),
  { id: 'history.back', title: 'Back', group: 'Tabs', palette: true, keys: [{ kind: 'mod', key: '[', modes: NAV_MODES }] },
  { id: 'history.forward', title: 'Forward', group: 'Tabs', palette: true, keys: [{ kind: 'mod', key: ']', modes: NAV_MODES }] },
```

  - `keyCaps` needs no change for `[` / `]`: upper-casing them is a no-op.

- [x] **Step 5: Create `src/ui/views/TabBar.tsx`.**

```tsx
import type { MouseEvent } from 'react'
import { ArrowLeft, ArrowRight, Plus, X } from 'lucide-react'

interface Props {
  tabs: { id: number; label: string }[]
  active: number
  canBack: boolean
  canForward: boolean
  onSelect: (index: number) => void
  onClose: (index: number) => void
  onNew: () => void
  onBack: () => void
  onForward: () => void
}

/** Workspace tabs (Scape): ⌘T, ⌘W, ⌘1–9, ⌃Tab; back / forward per tab with ⌘[ / ⌘]. */
export function TabBar({ tabs, active, canBack, canForward, onSelect, onClose, onNew, onBack, onForward }: Props) {
  // Mouse use must not keep focus on a button, or j/k stop working.
  const blur = (e: MouseEvent<HTMLElement>): void => e.currentTarget.blur()
  return (
    <div className="tab-bar">
      <button className="tab-nav" title="Back (⌘[)" aria-label="Back" disabled={!canBack} onClick={(e) => (blur(e), onBack())}>
        <ArrowLeft size={13} strokeWidth={2} />
      </button>
      <button className="tab-nav" title="Forward (⌘])" aria-label="Forward" disabled={!canForward} onClick={(e) => (blur(e), onForward())}>
        <ArrowRight size={13} strokeWidth={2} />
      </button>
      <div className="tab-list" role="tablist">
        {tabs.map((t, i) => (
          <div key={t.id} className="tab" role="tab" aria-selected={i === active} onClick={(e) => (blur(e), onSelect(i))}>
            <span className="tab-label">{t.label}</span>
            {tabs.length > 1 && (
              <button
                className="tab-close"
                aria-label={`Close ${t.label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  blur(e)
                  onClose(i)
                }}
              >
                <X size={11} strokeWidth={2.5} />
              </button>
            )}
          </div>
        ))}
        <button className="tab-nav" title="New tab (⌘T)" aria-label="New tab" onClick={(e) => (blur(e), onNew())}>
          <Plus size={13} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}
```

  Append to `src/ui/styles/app.css` (map the colours to the tokens `tokens.css` defines):

```css
.tab-bar { display: flex; align-items: center; gap: 2px; height: 30px; padding: 0 8px; border-bottom: 1px solid var(--border); -webkit-app-region: drag; }
.tab-bar button, .tab-bar .tab { -webkit-app-region: no-drag; }
.tab-nav { display: grid; place-items: center; width: 22px; height: 22px; border: 0; border-radius: 5px; background: none; color: var(--text-muted); cursor: pointer; }
.tab-nav:disabled { opacity: 0.35; cursor: default; }
.tab-nav:not(:disabled):hover { background: var(--hover); }
.tab-list { display: flex; align-items: center; gap: 2px; min-width: 0; flex: 1; overflow: hidden; }
.tab { display: flex; align-items: center; gap: 4px; max-width: 180px; height: 22px; padding: 0 6px 0 10px; border-radius: 5px; font-size: 12px; color: var(--text-muted); cursor: default; }
.tab[aria-selected='true'] { background: var(--hover); color: var(--text); }
.tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab-close { display: grid; place-items: center; width: 16px; height: 16px; border: 0; border-radius: 4px; background: none; color: inherit; opacity: 0.6; }
.tab-close:hover { opacity: 1; background: var(--border); }
```

- [x] **Step 6: Wire App.** In `src/ui/App.tsx`:
  - Imports: `import { TabBar } from './views/TabBar'`; from `./workspace` import `back, canGoBack, canGoForward, closeTab, currentView, cycleTab, forward, initWorkspace, openTab, record, restoreWorkspace, selectTab, serializeWorkspace, type View, type Workspace`.
  - Order matters: a hook's dependency array is evaluated during render, so `applyView` must be declared before the boot `useEffect` that lists it. Move `openThreadAndRead` (it only needs `openThreadView` and `markRowSeen`) up to directly above the boot `useEffect`, and put this block between the two:

```ts
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const workspaceRef = useRef<Workspace | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitWorkspace = useCallback((ws: Workspace) => {
    workspaceRef.current = ws
    setWorkspace(ws)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void window.api.setSettings({ workspace: serializeWorkspace(ws) })
    }, 500)
  }, [])

  /** The view on screen, read from the store. Null before the first folder is chosen. */
  const viewNow = useCallback((): View | null => {
    const s = useStore.getState()
    if (s.activeFolderId === null) return null
    return {
      folderId: s.activeFolderId,
      splitId: s.splitId,
      chip: s.chip,
      thread: s.openThread
        ? { threadId: s.openThread.threadId, messageId: s.openThread.messageId, accountId: s.openThread.accountId }
        : null
    }
  }, [])

  /**
   * Puts a view on screen: back / forward and tab switches. Every store change
   * happens before the first await, so the recorder below sees the target
   * view, finds it equal to the current entry, and adds no step.
   */
  const applyView = useCallback(
    async (v: View) => {
      const st = useStore.getState()
      setTasksOpen(false)
      const listChanged = st.activeFolderId !== v.folderId || st.splitId !== v.splitId || st.chip !== v.chip
      if (listChanged) {
        clearChecked()
        setActiveFolder(v.folderId)
        setSplit(v.splitId)
        setChip(v.chip)
      }
      if (v.thread) {
        const ot = st.openThread
        if (!ot || ot.threadId !== v.thread.threadId || ot.accountId !== v.thread.accountId)
          openThreadAndRead(v.thread.threadId, v.thread.messageId, v.thread.accountId)
      } else if (st.openThread) closeThread()
      if (listChanged) await loadRows(v.folderId)
    },
    [clearChecked, setActiveFolder, setSplit, setChip, openThreadAndRead, closeThread, loadRows]
  )

  const showWorkspace = useCallback(
    (next: Workspace | null) => {
      if (!next || next === workspaceRef.current) return
      commitWorkspace(next)
      void applyView(currentView(next))
    },
    [commitWorkspace, applyView]
  )

  // Records every navigation as a history step, whoever caused it (sidebar,
  // g-keys, opening or closing a thread, auto-advance). Coalesced so a
  // close-then-open (auto-advance) is one step.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = useStore.subscribe((s, prev) => {
      if (
        s.activeFolderId === prev.activeFolderId &&
        s.splitId === prev.splitId &&
        s.chip === prev.chip &&
        s.openThread === prev.openThread
      )
        return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        const ws = workspaceRef.current
        const v = viewNow()
        if (!ws || !v) return
        const next = record(ws, v)
        if (next !== ws) commitWorkspace(next)
      }, 120)
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [viewNow, commitWorkspace])
```

  - Boot: in the boot `useEffect`, replace the block `if (cached.length) { setFolders(cached); if (inbox) { setActiveFolder(inbox.id); await loadRows(inbox.id) } }` with:

```ts
      if (cached.length) {
        setFolders(cached)
        if (inbox) {
          const fallback: View = { folderId: inbox.id, splitId: 'all', chip: null, thread: null }
          const ids = new Set(cached.map((f) => f.id))
          const special = [REMINDERS_VIEW_ID, ...((status.accounts?.length ?? 0) > 1 ? [UNIFIED_VIEW_ID] : [])]
          const saved = (await window.api.getSettings()).workspace
          if (cancelled) return
          const ws = restoreWorkspace(saved, (v) => ids.has(v.folderId) || special.includes(v.folderId), fallback)
          commitWorkspace(ws)
          await applyView(currentView(ws))
        }
      }
```

    and add `commitWorkspace` and `applyView` to that effect's dependency list. If `cached` is empty (first run), add after the post-sync `setActiveFolder(target.id)` / `loadRows` block: `if (!workspaceRef.current && target) commitWorkspace(initWorkspace({ folderId: target.id, splitId: 'all', chip: null, thread: null }))`.
  - Handlers (inside `withTiming`):

```ts
        'tab.new': () => {
          const ws = workspaceRef.current
          const v = viewNow()
          if (ws && v) showWorkspace(openTab(ws, { ...v, thread: null }))
        },
        'tab.close': () => stepWorkspace((w) => closeTab(w)),
        'tab.next': () => stepWorkspace((w) => cycleTab(w, 1)),
        'tab.prev': () => stepWorkspace((w) => cycleTab(w, -1)),
        ...(Object.fromEntries(
          DIGITS.map((d, i) => [`tab.${d}`, () => stepWorkspace((w) => selectTab(w, i))])
        ) as Handlers),
        'history.back': () => stepWorkspace(back),
        'history.forward': () => stepWorkspace(forward),
```

    where `stepWorkspace` is defined next to `showWorkspace`:

```ts
  /** Applies a transition to the current workspace. Handlers return void, so no `a && b()` here. */
  const stepWorkspace = useCallback(
    (f: (ws: Workspace) => Workspace | null) => {
      const ws = workspaceRef.current
      if (ws) showWorkspace(f(ws))
    },
    [showWorkspace]
  )
```

    Add `viewNow`, `showWorkspace` and `stepWorkspace` to the `handlers` dependency list.
  - Tab labels, before `return (` of the main render:

```ts
  const viewLabel = (v: View): string => {
    if (v.thread) return rows.find((r) => r.id === v.thread!.messageId)?.subject || 'Conversation'
    if (v.folderId === UNIFIED_VIEW_ID) return 'All inboxes'
    if (v.folderId === REMINDERS_VIEW_ID) return 'Reminders'
    const f = folders.find((x) => x.id === v.folderId)
    return f ? folderLabel(f) : 'Mail'
  }
```

  - Render, as the first child of `<main className="main">`:

```tsx
        {workspace && (
          <TabBar
            tabs={workspace.tabs.map((t) => ({ id: t.id, label: viewLabel(t.history[t.index]) }))}
            active={workspace.active}
            canBack={canGoBack(workspace)}
            canForward={canGoForward(workspace)}
            onSelect={(i) => showWorkspace(selectTab(workspace, i))}
            onClose={(i) => showWorkspace(closeTab(workspace, i))}
            onNew={() => {
              const v = viewNow()
              if (v) showWorkspace(openTab(workspace, { ...v, thread: null }))
            }}
            onBack={() => showWorkspace(back(workspace))}
            onForward={() => showWorkspace(forward(workspace))}
          />
        )}
```

  Note `selectTab(workspace, i)` for a click must pick exactly tab `i`, but `selectTab` maps index 8 to the last tab; with `MAX_TABS = 9` index 8 *is* the last tab, so a click is exact.

- [x] **Step 7: Run the tests, then the suite.** `pnpm exec vitest run src/ui` passes. `pnpm typecheck && pnpm test` green (**65 files**).

- [ ] **Step 8: Check in the app.** `pnpm dev`: `⌘T` opens a second tab on the current list; `g s` in it, then `⌘1` returns to the Inbox tab with its own list; `⌘[` / `⌘]` walk back through Inbox → thread → Sent; `⌘W` closes a tab and does **not** close the window; `⇧⌘W` closes the window; quit and relaunch restores the tabs.

- [ ] **Step 9: Commit.**

```bash
git add src/ui
git commit -m "[feat] workspace tabs with per-tab back and forward"
```

---
### Task 6: Reading a thread from the keyboard

`o` / `O` expand one or all, `n` / `p` move between messages, `Space` / `⇧Space` page, `Tab` / `⇧Tab` cycle the focused message's links, `⌘O` opens the selected link (else the first attachment), `j` / `k` move to the next or previous conversation, `↵` replies all, and the header shows "15 / 201" with up/down buttons *(Scape)*.

**Files:**
- Create: `src/ui/threadNav.ts`, `src/ui/threadNav.test.ts`
- Modify: `src/ui/hooks/useHotkeys.ts`, `src/ui/commands.ts`, `src/ui/commands.test.ts`, `src/ui/views/Thread.tsx`, `src/ui/views/MessageBody.tsx`, `src/ui/App.tsx`, `src/ui/styles/app.css`

- [x] **Step 1: Write the failing tests.** Create `src/ui/threadNav.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { cycleIndex, positionLabel, stepIndex, toggleAllExpanded } from './threadNav.js'

describe('thread navigation', () => {
  it('steps between messages without leaving the thread', () => {
    expect(stepIndex(0, 1, 3)).toBe(1)
    expect(stepIndex(2, 1, 3)).toBe(2)
    expect(stepIndex(0, -1, 3)).toBe(0)
    expect(stepIndex(0, 1, 0)).toBe(0)
  })

  it('expands every message, or back to the focused one when all are open', () => {
    expect([...toggleAllExpanded(new Set([2]), [1, 2, 3], 2)]).toEqual([1, 2, 3])
    expect([...toggleAllExpanded(new Set([1, 2, 3]), [1, 2, 3], 2)]).toEqual([2])
    expect([...toggleAllExpanded(new Set(), [], null)]).toEqual([])
  })

  it('cycles links from the first (or last, going back) and wraps', () => {
    expect(cycleIndex(null, 1, 3)).toBe(0)
    expect(cycleIndex(null, -1, 3)).toBe(2)
    expect(cycleIndex(2, 1, 3)).toBe(0)
    expect(cycleIndex(0, -1, 3)).toBe(2)
    expect(cycleIndex(null, 1, 0)).toBeNull()
  })

  it('counts the position across pages', () => {
    expect(positionLabel(4, 0, 50, 201)).toBe('5 / 201')
    expect(positionLabel(14, 2, 50, 201)).toBe('115 / 201')
    expect(positionLabel(-1, 0, 50, 201)).toBeNull()
    expect(positionLabel(0, 0, 50, 0)).toBeNull()
  })
})
```

  In `src/ui/commands.test.ts`, add:

```ts
  it('gives a thread its reading keys, Enter as reply all, and ⌘O', () => {
    const ids = [
      'thread.replyAll',
      'thread.nextConv',
      'thread.prevConv',
      'thread.nextMsg',
      'thread.prevMsg',
      'thread.expand',
      'thread.expandAll',
      'thread.pageDown',
      'thread.pageUp',
      'thread.nextLink',
      'thread.prevLink'
    ]
    const h = Object.fromEntries(ids.map((id) => [id, () => {}])) as Handlers
    expect(buildBindings('thread', h).map((b) => [b.key, b.modes])).toEqual([
      ['Enter', ['thread']],
      ['R', ['thread']],
      ['j', ['thread']],
      ['k', ['thread']],
      ['n', ['thread']],
      ['p', ['thread']],
      ['o', ['thread']],
      ['O', ['thread']],
      ['Space', ['thread']],
      ['Shift+Space', ['thread']],
      ['Tab', ['thread']],
      ['Shift+Tab', ['thread']]
    ])
    expect(buildChords('thread', { 'thread.open': () => {} }).map((c) => c.key)).toEqual(['o'])
    expect(buildChords('list', { 'thread.open': () => {} })).toEqual([])
  })

  it('reads Space and Shift+Space as keys of their own', () => {
    expect(eventKey({ key: ' ', shiftKey: false })).toBe('Space')
    expect(eventKey({ key: ' ', shiftKey: true })).toBe('Shift+Space')
    expect(keyCaps({ kind: 'key', key: 'Space' })).toEqual(['Space'])
    expect(keyCaps({ kind: 'key', key: 'Shift+Space' })).toEqual(['⇧', 'Space'])
  })
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/ui/threadNav.test.ts src/ui/commands.test.ts`. Expected: FAIL.

- [x] **Step 3: Create `src/ui/threadNav.ts`.**

```ts
/** i + delta, kept inside 0..n-1. */
export function stepIndex(i: number, delta: number, n: number): number {
  if (n <= 0) return 0
  return Math.max(0, Math.min(n - 1, i + delta))
}

/** ⇧O: expand every message, or back to just the focused one when all are open. */
export function toggleAllExpanded(
  expanded: ReadonlySet<number>,
  ids: number[],
  focusedId: number | null
): Set<number> {
  const allOpen = ids.length > 0 && ids.every((id) => expanded.has(id))
  if (allOpen) return new Set(focusedId !== null ? [focusedId] : [])
  return new Set(ids)
}

/** Tab through links: starts at the first (or the last, going back) and wraps. Null when there are none. */
export function cycleIndex(i: number | null, delta: number, n: number): number | null {
  if (n <= 0) return null
  if (i === null) return delta >= 0 ? 0 : n - 1
  return (((i + delta) % n) + n) % n
}

/** "15 / 201" *(Scape)*: the open conversation's place in the whole view, not just this page. */
export function positionLabel(index: number, page: number, pageSize: number, total: number): string | null {
  if (index < 0 || total <= 0) return null
  return `${page * pageSize + index + 1} / ${total}`
}
```

- [x] **Step 4: Space as a key.** In `src/ui/hooks/useHotkeys.ts`, replace `eventKey`:

```ts
/**
 * KeyboardEvent.key, except Shift+Tab (reports 'Tab') and Space (reports ' '),
 * which become 'Shift+Tab', 'Space' and 'Shift+Space' so each is its own binding.
 */
export function eventKey(e: { key: string; shiftKey: boolean }): string {
  if (e.key === 'Tab' && e.shiftKey) return 'Shift+Tab'
  if (e.key === ' ') return e.shiftKey ? 'Shift+Space' : 'Space'
  return e.key
}
```

  In `src/ui/commands.ts`, add `Space: 'Space'` to `NAMED`, and in `keyCaps` next to the `Shift+Tab` line add `if (k === 'Shift+Space') return ['⇧', 'Space']`.

- [x] **Step 5: Register the thread commands.** In `src/ui/commands.ts`:
  - Add to `CommandId`: `'thread.nextConv' | 'thread.prevConv' | 'thread.nextMsg' | 'thread.prevMsg' | 'thread.expand' | 'thread.expandAll' | 'thread.pageDown' | 'thread.pageUp' | 'thread.nextLink' | 'thread.prevLink' | 'thread.open'`.
  - Change `thread.replyAll`'s keys to `[{ kind: 'key', key: 'Enter', modes: ['thread'] }, { kind: 'key', key: 'R', modes: ['thread'] }]` (Scape and Superhuman: ↵ replies all).
  - After `thread.forward`, add (j / k are list-only today, so in a thread they are free):

```ts
  { id: 'thread.nextConv', title: 'Next conversation', group: 'In a thread', keys: [{ kind: 'key', key: 'j', modes: ['thread'] }] },
  { id: 'thread.prevConv', title: 'Previous conversation', group: 'In a thread', keys: [{ kind: 'key', key: 'k', modes: ['thread'] }] },
  { id: 'thread.nextMsg', title: 'Next message', group: 'In a thread', keys: [{ kind: 'key', key: 'n', modes: ['thread'] }] },
  { id: 'thread.prevMsg', title: 'Previous message', group: 'In a thread', keys: [{ kind: 'key', key: 'p', modes: ['thread'] }] },
  { id: 'thread.expand', title: 'Expand / collapse message', group: 'In a thread', keys: [{ kind: 'key', key: 'o', modes: ['thread'] }] },
  { id: 'thread.expandAll', title: 'Expand / collapse all', group: 'In a thread', keys: [{ kind: 'key', key: 'O', modes: ['thread'] }] },
  { id: 'thread.pageDown', title: 'Page down', group: 'In a thread', keys: [{ kind: 'key', key: 'Space', modes: ['thread'] }] },
  { id: 'thread.pageUp', title: 'Page up', group: 'In a thread', keys: [{ kind: 'key', key: 'Shift+Space', modes: ['thread'] }] },
  { id: 'thread.nextLink', title: 'Next link', group: 'In a thread', keys: [{ kind: 'key', key: 'Tab', modes: ['thread'] }] },
  { id: 'thread.prevLink', title: 'Previous link', group: 'In a thread', keys: [{ kind: 'key', key: 'Shift+Tab', modes: ['thread'] }] },
  { id: 'thread.open', title: 'Open link or attachment', group: 'In a thread', keys: [{ kind: 'mod', key: 'o', modes: ['thread'] }] },
```

- [x] **Step 6: MessageBody reports links and attachments.** In `src/ui/views/MessageBody.tsx`:
  - Add to `Props`:

```ts
  /** Called once the body is in: the thread needs links (Tab) and attachments (⌘O). */
  onLoaded?: (info: { links: string[]; attachments: Attachment[] }) => void
  /** Index into this message's links that Tab selected, or null. */
  activeLink?: number | null
```

    (import `type Attachment` alongside `BodyResult` from `'../../../electron/preload'`).
  - After the fetch effect, add:

```ts
  useEffect(() => {
    if (body?.ok) onLoaded?.({ links: extractLinks(body.html), attachments: body.attachments })
    // onLoaded is a fresh closure each render; only a new body should report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body])
```

  - On the links list, open it while a link is selected and mark that link:

```tsx
        <details className="body-links" open={activeLink != null ? true : undefined}>
          …
            {links.map((href, i) => (
              <li key={i} data-active={i === activeLink}>
```

- [x] **Step 7: Thread exposes a handle.** Rewrite `src/ui/views/Thread.tsx`:

```tsx
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  Archive,
  ArrowLeft,
  ArrowUpLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  MailOpen,
  Star,
  Trash2
} from 'lucide-react'
import type { Attachment } from '../../../electron/preload'
import type { Message } from '../../core/store/types'
import { decodeEntities, formatDate, senderLabel } from '../format'
import { cycleIndex, stepIndex, toggleAllExpanded } from '../threadNav'
import { MessageBody } from './MessageBody'

interface Props {
  threadId: string
  focusMessageId: number
  accountId?: number
  /** "15 / 201", or null when the thread is not in the list on screen. */
  position: string | null
  onPrevConversation: () => void
  onNextConversation: () => void
  onBack: () => void
  onReply: (all: boolean) => void
  onForward: () => void
  onDone: () => void
  onTrash: () => void
  onStar: () => void
  onToggleRead: () => void
  starred: boolean
}

/** Driven by App's registry handlers: the keys live in commands.ts, the reading state lives here. */
export interface ThreadHandle {
  toggleFocused(): void
  toggleAll(): void
  step(delta: number): void
  page(dir: 1 | -1): void
  cycleLink(delta: number): void
  openActive(): void
}

export const Thread = forwardRef<ThreadHandle, Props>(function Thread(
  {
    threadId,
    focusMessageId,
    accountId,
    position,
    onPrevConversation,
    onNextConversation,
    onBack,
    onReply,
    onForward,
    onDone,
    onTrash,
    onStar,
    onToggleRead,
    starred
  },
  ref
) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set([focusMessageId]))
  const [focused, setFocused] = useState(0)
  const [activeLink, setActiveLink] = useState<number | null>(null)
  const loaded = useRef(new Map<number, { links: string[]; attachments: Attachment[] }>())
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    window.api.getThread(threadId, accountId).then((m) => {
      if (cancelled) return
      setMessages(m)
      // The selected message, or the newest (first: the thread is date DESC).
      const i = Math.max(0, m.findIndex((x) => x.id === focusMessageId))
      setFocused(i)
      setActiveLink(null)
      if (m[i]) setExpanded(new Set([m[i].id]))
    })
    return () => {
      cancelled = true
    }
  }, [threadId, focusMessageId, accountId])

  useEffect(() => {
    scrollRef.current?.querySelector(`[data-index="${focused}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  useImperativeHandle(ref, (): ThreadHandle => {
    const ids = messages?.map((m) => m.id) ?? []
    const focusedId = ids[focused] ?? null
    return {
      toggleFocused: () => {
        if (focusedId === null) return
        setExpanded((prev) => {
          const next = new Set(prev)
          if (next.has(focusedId)) next.delete(focusedId)
          else next.add(focusedId)
          return next
        })
      },
      toggleAll: () => setExpanded((prev) => toggleAllExpanded(prev, ids, focusedId)),
      step: (delta: number) => {
        setFocused((i) => stepIndex(i, delta, ids.length))
        setActiveLink(null)
      },
      page: (dir: 1 | -1) => {
        const el = scrollRef.current
        if (el) el.scrollBy({ top: dir * el.clientHeight * 0.85 })
      },
      cycleLink: (delta: number) => {
        if (focusedId === null) return
        // Links come from the body, so a collapsed message opens first.
        if (!expanded.has(focusedId)) setExpanded((prev) => new Set(prev).add(focusedId))
        const n = loaded.current.get(focusedId)?.links.length ?? 0
        setActiveLink((i) => cycleIndex(i, delta, n))
      },
      openActive: () => {
        const info = focusedId === null ? undefined : loaded.current.get(focusedId)
        if (!info) return
        const link = activeLink !== null ? info.links[activeLink] : undefined
        if (link) void window.api.openExternal(link)
        else if (info.attachments[0]) void window.api.openAttachment(info.attachments[0].id)
      }
    }
  }, [messages, focused, expanded, activeLink])

  if (!messages) return <div className="thread-loading" />
  if (!messages.length)
    return (
      <div className="empty">
        <span>Message not found</span>
      </div>
    )

  const subject = messages.find((m) => m.subject)?.subject ?? '(no subject)'

  return (
    <div className="thread">
      <header className="thread-header">
        <button className="back-button" onClick={onBack} aria-label="Back to list">
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
        <h2 className="thread-subject">{subject}</h2>
        <span className="thread-count">
          {messages.length} message{messages.length === 1 ? '' : 's'}
        </span>
        {position && (
          <span className="thread-position">
            <button type="button" title="Previous conversation (k)" aria-label="Previous conversation" onClick={onPrevConversation}>
              <ChevronUp size={14} strokeWidth={2} />
            </button>
            <span>{position}</span>
            <button type="button" title="Next conversation (j)" aria-label="Next conversation" onClick={onNextConversation}>
              <ChevronDown size={14} strokeWidth={2} />
            </button>
          </span>
        )}
        <div className="thread-actions">
          <button type="button" title="Done (e)" aria-label="Done" onClick={onDone}>
            <Archive size={15} strokeWidth={2} />
          </button>
          <button type="button" title="Trash (⌫)" aria-label="Trash" onClick={onTrash}>
            <Trash2 size={15} strokeWidth={2} />
          </button>
          <button type="button" title="Star (s)" aria-label="Star" aria-pressed={starred} data-on={starred} onClick={onStar}>
            <Star size={15} strokeWidth={2} fill={starred ? 'currentColor' : 'none'} />
          </button>
          <button type="button" title="Mark unread (u)" aria-label="Mark unread" onClick={onToggleRead}>
            <MailOpen size={15} strokeWidth={2} />
          </button>
        </div>
      </header>

      <div className="thread-scroll" ref={scrollRef}>
        {messages.map((m, i) => {
          const open = expanded.has(m.id)
          return (
            <article key={m.id} className="thread-message" data-open={open} data-index={i} data-focused={i === focused}>
              <button
                className="message-head"
                onClick={() => {
                  setFocused(i)
                  setExpanded((prev) => {
                    const next = new Set(prev)
                    if (next.has(m.id)) next.delete(m.id)
                    else next.add(m.id)
                    return next
                  })
                }}
              >
                <span className="message-sender">{senderLabel(m.from_name, m.from_addr)}</span>
                {/* Collapsed rows swap the address for a preview, so a long
                    thread can be skimmed without opening every message. */}
                {open ? (
                  <span className="message-addr">{m.from_addr}</span>
                ) : (
                  <span className="message-preview">{decodeEntities(m.snippet)}</span>
                )}
                <span className="message-date">{formatDate(m.date)}</span>
              </button>
              {open && (
                <MessageBody
                  messageId={m.id}
                  activeLink={i === focused ? activeLink : null}
                  onLoaded={(info) => loaded.current.set(m.id, info)}
                />
              )}
            </article>
          )
        })}

        {/* Reply lives at the end of the conversation, where you finish reading. */}
        <div className="thread-reply-bar">
          <button type="button" onClick={() => onReply(false)}>
            <ArrowUpLeft size={14} strokeWidth={2} /> Reply
            <span className="thread-reply-hint">r</span>
          </button>
          <button type="button" onClick={() => onReply(true)}>
            <ArrowUpLeft size={14} strokeWidth={2} /> Reply all
            <span className="thread-reply-hint">↵</span>
          </button>
          <button type="button" onClick={onForward}>
            <ArrowUpRight size={14} strokeWidth={2} /> Forward
            <span className="thread-reply-hint">f</span>
          </button>
        </div>
      </div>
    </div>
  )
})
```

  Append to `src/ui/styles/app.css`:

```css
.thread-position { display: inline-flex; align-items: center; gap: 2px; font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.thread-position button { display: grid; place-items: center; width: 20px; height: 20px; border: 0; border-radius: 4px; background: none; color: inherit; cursor: pointer; }
.thread-position button:hover { background: var(--hover); }
.thread-message[data-focused='true'] > .message-head { box-shadow: inset 2px 0 0 var(--accent); }
.body-links li[data-active='true'] button { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 3px; }
```

- [x] **Step 8: Wire App.** In `src/ui/App.tsx`:
  - Import `type ThreadHandle` from `./views/Thread` and `positionLabel` from `./threadNav`.
  - `const threadRef = useRef<ThreadHandle>(null)`.
  - After `unreadFromThread` (not between `triageFromThread` and `starFromThread`: `threadTarget.test.ts` reads that span of `App.tsx` as text):

```ts
  /** j / k and the header arrows: open the neighbouring row of the list behind the thread. */
  const stepConversation = useCallback(
    (delta: number) => {
      const st = useStore.getState()
      if (!st.openThread) return
      const { index } = openThreadTarget(st.rows, st.openThread)
      const next = index + delta
      if (index < 0 || next < 0 || next >= st.rows.length) return
      setSelectedIndex(next)
      openRow(next)
    },
    [setSelectedIndex, openRow]
  )
```

  - Handlers:

```ts
        'thread.nextConv': () => stepConversation(1),
        'thread.prevConv': () => stepConversation(-1),
        'thread.nextMsg': () => threadRef.current?.step(1),
        'thread.prevMsg': () => threadRef.current?.step(-1),
        'thread.expand': () => threadRef.current?.toggleFocused(),
        'thread.expandAll': () => threadRef.current?.toggleAll(),
        'thread.pageDown': () => threadRef.current?.page(1),
        'thread.pageUp': () => threadRef.current?.page(-1),
        'thread.nextLink': () => threadRef.current?.cycleLink(1),
        'thread.prevLink': () => threadRef.current?.cycleLink(-1),
        'thread.open': () => threadRef.current?.openActive(),
```

    Add `stepConversation` to the `handlers` dependency list.
  - Render the thread with the handle and counter:

```tsx
          <Thread
            ref={threadRef}
            threadId={openThread.threadId}
            focusMessageId={openThread.messageId}
            accountId={openThread.accountId}
            position={positionLabel(openThreadTarget(rows, openThread).index, page, PAGE_SIZE, totalRows)}
            onPrevConversation={() => stepConversation(-1)}
            onNextConversation={() => stepConversation(1)}
            …the existing callbacks…
          />
```

- [x] **Step 9: Run the tests, then the suite.** `pnpm exec vitest run src/ui` passes. `pnpm typecheck && pnpm test` green (**66 files**). The `bodyLinks.test.ts` sandbox assertions on `MessageBody.tsx` must still pass untouched.

- [ ] **Step 10: Check in the app.** `pnpm dev`, open a long thread: `n`/`p` move the focus bar, `o` / `O` expand, `Space` pages, `Tab` opens the links list and highlights one, `⌘O` opens it in the browser, `↵` opens Reply all, `j` / `k` and the header arrows walk the list with the counter updating.

- [ ] **Step 11: Commit.**

```bash
git add src/ui
git commit -m "[feat] thread reading keys, position counter, enter replies all"
```

---

### Task 7: Compose — field jumps, Send + Done, send later, Instant Intro

**Files:**
- Create: `src/ui/intro.ts`, `src/ui/intro.test.ts`
- Modify: `src/ui/commands.ts`, `src/ui/commands.test.ts`, `src/ui/store.ts`, `src/ui/views/Compose.tsx`, `src/ui/views/RecipientField.tsx`, `src/ui/views/RemindPicker.tsx`, `src/ui/App.tsx`

- [x] **Step 1: Write the failing tests.** Create `src/ui/intro.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { instantIntro } from './intro.js'

describe('instantIntro', () => {
  it('moves the introducer to Bcc and writes to the person introduced', () => {
    expect(
      instantIntro({ to: 'Ann Lee <ann@x.test>', cc: 'bob@y.test, carl@z.test', bcc: '', body: '<p>Hi</p>' })
    ).toEqual({
      to: 'bob@y.test',
      cc: 'carl@z.test',
      bcc: 'Ann Lee <ann@x.test>',
      body: '<p>Thanks Ann! (Moving you to Bcc.)</p><p>Hi</p>'
    })
  })

  it('keeps other To recipients on the To line, and names someone from their address', () => {
    expect(instantIntro({ to: 'ann@x.test, bob@y.test', cc: 'carl@z.test', bcc: '', body: '' })).toEqual({
      to: 'bob@y.test',
      cc: 'carl@z.test',
      bcc: 'ann@x.test',
      body: '<p>Thanks Ann! (Moving you to Bcc.)</p>'
    })
  })

  it('does not put the introducer in Bcc twice', () => {
    expect(instantIntro({ to: 'ann@x.test', cc: 'bob@y.test', bcc: 'ANN@x.test', body: '' })?.bcc).toBe('ann@x.test')
  })

  it('escapes the name it writes', () => {
    expect(instantIntro({ to: 'R&D <rd@x.test>', cc: 'bob@y.test', bcc: '', body: '' })?.body).toBe(
      '<p>Thanks R&amp;D! (Moving you to Bcc.)</p>'
    )
  })

  it('gives up when nobody would be left to write to', () => {
    expect(instantIntro({ to: 'ann@x.test', cc: '', bcc: '', body: '' })).toBeNull()
    expect(instantIntro({ to: '', cc: 'bob@y.test', bcc: '', body: '' })).toBeNull()
  })
})
```

  In `src/ui/commands.test.ts`, add:

```ts
  it('declares the new compose chords for the editor only', () => {
    const ids = [
      'compose.sendDone',
      'compose.sendLater',
      'compose.intro',
      'compose.focusTo',
      'compose.focusCc',
      'compose.focusBcc',
      'compose.focusSubject'
    ]
    for (const id of ids) {
      const c = COMMANDS.find((x) => x.id === id)!
      expect(c.external, id).toBe(true)
      expect(c.keys[0], id).toMatchObject({ kind: 'mod', shift: true, modes: ['compose'] })
    }
    const h = Object.fromEntries(ids.map((id) => [id, () => {}])) as Handlers
    expect(buildChords('compose', h)).toEqual([])
  })
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/ui/intro.test.ts src/ui/commands.test.ts`. Expected: FAIL.

- [x] **Step 3: Create `src/ui/intro.ts`.**

```ts
export interface IntroFields {
  to: string
  cc: string
  bcc: string
  body: string
}

function split(s: string): string[] {
  return s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function addrOf(entry: string): string {
  const m = /<([^>]+)>\s*$/.exec(entry)
  return (m ? m[1] : entry).trim().toLowerCase()
}

function firstNameOf(entry: string): string {
  const m = /^(.*?)<[^>]+>\s*$/.exec(entry)
  const name = m ? m[1].trim().replace(/^"|"$/g, '').trim() : ''
  if (name) return name.split(/\s+/)[0]
  const local = addrOf(entry).split('@')[0]
  return local.charAt(0).toUpperCase() + local.slice(1)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Superhuman's Instant Intro (⌘⇧I), for replying to an introduction: the
 * person who made the intro (first To, the sender in a reply all) moves to
 * Bcc with a thank-you line, and the person introduced becomes the To.
 * Null when nobody would be left to write to.
 */
export function instantIntro(f: IntroFields): IntroFields | null {
  const [introducer, ...restTo] = split(f.to)
  if (!introducer) return null
  const cc = split(f.cc)
  const to = restTo.length ? restTo : cc.slice(0, 1)
  const keepCc = restTo.length ? cc : cc.slice(1)
  if (!to.length) return null
  const bcc = [...split(f.bcc).filter((a) => addrOf(a) !== addrOf(introducer)), introducer]
  return {
    to: to.join(', '),
    cc: keepCc.join(', '),
    bcc: bcc.join(', '),
    body: `<p>Thanks ${escapeHtml(firstNameOf(introducer))}! (Moving you to Bcc.)</p>${f.body}`
  }
}
```

- [x] **Step 4: Register the chords.** In `src/ui/commands.ts`, add to `CommandId`: `'compose.sendDone' | 'compose.sendLater' | 'compose.intro' | 'compose.focusTo' | 'compose.focusCc' | 'compose.focusBcc' | 'compose.focusSubject'`, and after `compose.send`:

```ts
  { id: 'compose.sendDone', title: 'Send and mark done', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'Enter', shift: true, modes: ['compose'] }] },
  { id: 'compose.sendLater', title: 'Send later…', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'l', shift: true, modes: ['compose'] }] },
  { id: 'compose.intro', title: 'Instant intro (sender to Bcc)', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'i', shift: true, modes: ['compose'] }] },
  { id: 'compose.focusTo', title: 'Go to To', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'o', shift: true, modes: ['compose'] }] },
  { id: 'compose.focusCc', title: 'Go to Cc', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'c', shift: true, modes: ['compose'] }] },
  { id: 'compose.focusBcc', title: 'Go to Bcc', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'b', shift: true, modes: ['compose'] }] },
  { id: 'compose.focusSubject', title: 'Go to Subject', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 's', shift: true, modes: ['compose'] }] },
```

- [x] **Step 5: Store.** In `src/ui/store.ts`, add to `ComposeState`: `/** The message replied to or forwarded; ⌘⇧↵ marks its thread Done. */ sourceMessageId: number | null`, and `sourceMessageId: null` in `emptyCompose()`.

- [x] **Step 6: Field ids and a picker without its checkbox.**
  - `src/ui/views/RecipientField.tsx`: add `inputId?: string` to `Props`, destructure it, and set `id={inputId}` on the `<input>`.
  - `src/ui/views/RemindPicker.tsx`: add to `Props` `/** The checkbox under the presets; send later hides it. */ showCheck?: boolean` and `checkLabel?: string`; default them to `true` and `'Only if nobody replies'` in the destructuring; wrap the `<label className="picker-check">` in `{showCheck && (…)}` and render `{checkLabel}` in place of the fixed text.

- [x] **Step 7: Compose.** In `src/ui/views/Compose.tsx`:
  - Import `instantIntro` from `'../intro'`.
  - `onSent` prop type: `(outboxId: number, subject: string, undoMs: number, immediate: boolean, doneId: number | null) => void | Promise<void>`.
  - Delete `SCHEDULE_OPTS` and `scheduleAt`; replace the `showSchedule` state with `const [laterOpen, setLaterOpen] = useState(false)`.
  - `persistAndQueue` becomes `async (sendAt: number | null, opts: { done?: boolean } = {}) => { … }`; its `onSent` call passes `opts.done ? compose.sourceMessageId : null` as the last argument.
  - Add, before `chords`:

```ts
  const introduce = useCallback(() => {
    const next = instantIntro({
      to: compose.to,
      cc: compose.cc,
      bcc: compose.bcc,
      body: editorRef.current?.innerHTML ?? compose.body
    })
    if (!next) return setError('Instant intro needs someone left to write to')
    // The DOM owns the body after the first seed, so write it there too.
    if (editorRef.current) editorRef.current.innerHTML = next.body
    updateCompose(next)
  }, [compose, updateCompose])
```

  - Replace `chords`:

```ts
  const focusField = (id: string) => () => document.getElementById(id)?.focus()
  // Each chord is declared in commands.ts (compose.*, external) so the sheet lists it.
  const chords = useMemo(
    () => [
      { key: 'Enter', handler: () => void (!sending && persistAndQueue(null)) },
      { key: 'Enter', shift: true, handler: () => void (!sending && persistAndQueue(null, { done: true })) },
      { key: 'h', shift: true, handler: () => setReminding(true) },
      { key: 'l', shift: true, handler: () => setLaterOpen(true) },
      { key: 'i', shift: true, handler: introduce },
      { key: 'o', shift: true, handler: focusField('compose-to') },
      { key: 'c', shift: true, handler: focusField('compose-cc') },
      { key: 'b', shift: true, handler: focusField('compose-bcc') },
      { key: 's', shift: true, handler: focusField('compose-subject') }
    ],
    [persistAndQueue, sending, introduce]
  )
```

  - The Escape effect checks `!laterOpen && !reminding` (deps `[onClose, laterOpen, reminding]`).
  - Replace the whole `compose-schedule-wrap` block with one button, and the Send button's handler with `persistAndQueue(null)`:

```tsx
          <button type="button" className="compose-btn" onClick={() => setLaterOpen(true)} disabled={sending} title="Send later (⌘⇧L)">
            Later
          </button>
```

  - Next to the existing `reminding` picker, add:

```tsx
      {laterOpen && (
        <RemindPicker
          title="Send later"
          showCheck={false}
          onPick={(at) => {
            setLaterOpen(false)
            void persistAndQueue(at)
          }}
          onClose={() => setLaterOpen(false)}
        />
      )}
```

  - Fields: `inputId="compose-to"`, `"compose-cc"`, `"compose-bcc"` on the three `RecipientField`s; `id="compose-subject"` on the subject `<input>`.

- [x] **Step 8: App — Send + Done with one undo.** In `src/ui/App.tsx`:
  - `startReply` and `startForward`: add `sourceMessageId: ot.messageId` to the `openCompose({...})` object.
  - Replace `onSent`:

```ts
  const onSent = useCallback(
    async (outboxId: number, subject: string, undoMs: number, immediate: boolean, doneId: number | null) => {
      const undoSend = async (): Promise<void> => {
        await window.api.cancelSend(outboxId)
      }
      if (doneId == null) {
        // A scheduled send is cancelled from ⌘K, not undone.
        if (immediate) pushUndo(`Sending “${subject}”`, undoMs, undoSend)
        return
      }
      // Send + Done. There is one undo slot, so one entry takes back both.
      const origin = viewKey(useStore.getState())
      const res = await window.api.moveMessages([doneId], { role: 'archive' })
      if (!res.ok) {
        setActionError(res.error === 'no archive folder' ? NO_ARCHIVE : res.error)
        if (immediate) pushUndo(`Sending “${subject}”`, undoMs, undoSend)
        return
      }
      const removed = dropRows(res.moved)
      if (useStore.getState().openThread) closeThread()
      void refreshUnread()
      pushUndo(
        immediate ? `Sent “${subject}” and marked done` : `Scheduled “${subject}”, marked done`,
        immediate ? Math.min(undoMs, res.holdMs) : res.holdMs,
        async () => {
          if (immediate) await undoSend()
          if (res.batchId) {
            const r = await window.api.undoMove(res.batchId)
            if (!r.ok) return setActionError(r.error)
          }
          repaintAfterUndo(origin, removed)
        }
      )
    },
    [pushUndo, dropRows, closeThread, refreshUnread, setActionError, repaintAfterUndo]
  )
```

- [x] **Step 9: Run the tests, then the suite.** `pnpm exec vitest run src/ui` passes. `pnpm typecheck && pnpm test` green (**67 files**).

- [ ] **Step 10: Check in the app.** Reply to a thread and press `⌘⇧↵`: the compose closes, the thread leaves the Inbox, and `z` brings it back *and* cancels the send. `⌘⇧L` opens "Send later" and "tomorrow 9am" schedules it (⌘K → Scheduled sends lists it). In a reply all to an introduction, `⌘⇧I` moves the sender to Bcc with the thank-you line. `⌘⇧O/C/B/S` jump between fields.

- [ ] **Step 11: Commit.**

```bash
git add src/ui
git commit -m "[feat] compose field jumps, send and done, send later, instant intro"
```

---

### Task 8: Snippets

`;name` then `⇥` expands a snippet inline; `⌘;` picks one from a list. Variables such as `{first_name}` fill from the first To recipient and from you.

**Files:**
- Create: `src/core/store/snippets.ts`, `src/core/store/snippets.test.ts`, `src/ui/snippetVars.ts`, `src/ui/snippetVars.test.ts`, `src/ui/views/SnippetSettings.tsx`
- Modify: `electron/ipcPower.ts`, `electron/preload.ts`, `src/ui/commands.ts`, `src/ui/commands.test.ts`, `src/ui/richText.ts`, `src/ui/views/Compose.tsx`, `src/ui/views/Settings.tsx`, `src/ui/App.tsx`, `src/ui/styles/app.css`

- [x] **Step 1: Write the failing tests.** Create `src/core/store/snippets.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, initDb } from './db.js'
import { deleteSnippet, listSnippets, saveSnippet } from './snippets.js'

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'snippets-')), 't.db'))
})

describe('snippets', () => {
  it('saves, lists by name, updates and deletes', () => {
    const b = saveSnippet({ name: 'Thanks', shortcut: ';thx', body: 'Thanks {first_name}!\n' })
    saveSnippet({ name: 'Availability', shortcut: null, body: 'Free Tue' })
    expect(b).toMatchObject({ name: 'Thanks', shortcut: 'thx', body: 'Thanks {first_name}!' })
    expect(listSnippets().map((s) => s.name)).toEqual(['Availability', 'Thanks'])
    expect(saveSnippet({ id: b.id, name: 'Thanks!', shortcut: 'ty', body: 'Thank you' })).toMatchObject({
      id: b.id,
      shortcut: 'ty'
    })
    deleteSnippet(b.id)
    expect(listSnippets().map((s) => s.name)).toEqual(['Availability'])
  })

  it('refuses a missing name or body and a malformed shortcut', () => {
    expect(() => saveSnippet({ name: ' ', body: 'x' })).toThrow(/name/)
    expect(() => saveSnippet({ name: 'x', body: '  ' })).toThrow(/name/)
    expect(() => saveSnippet({ name: 'x', shortcut: 'two words', body: 'x' })).toThrow(/Shortcut/)
  })

  it('says which shortcut is taken, ignoring case', () => {
    saveSnippet({ name: 'A', shortcut: 'hi', body: 'a' })
    expect(() => saveSnippet({ name: 'B', shortcut: 'HI', body: 'b' })).toThrow(/;HI is already used/)
  })
})
```

  Create `src/ui/snippetVars.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { expandSnippet, shortcutBeforeCaret, snippetHtml, snippetVars } from './snippetVars.js'

const now = new Date(2026, 9, 29, 10, 0)

describe('snippet variables', () => {
  it('fills names from the first To recipient and from you', () => {
    const v = snippetVars({ to: 'Ann Marie Lee <ann@x.test>, bob@y.test', me: { name: 'Kai Ye', email: 'kai@z.test' }, now })
    expect(v).toMatchObject({
      first_name: 'Ann',
      last_name: 'Marie Lee',
      name: 'Ann Marie Lee',
      email: 'ann@x.test',
      my_name: 'Kai Ye',
      my_first_name: 'Kai',
      my_email: 'kai@z.test',
      date: now.toLocaleDateString()
    })
  })

  it('leaves unknown or empty variables visible instead of blank', () => {
    const v = snippetVars({ to: 'ann@x.test', me: { name: null, email: null }, now })
    expect(expandSnippet('Hi {first_name}, {EMAIL} {nope}', v)).toBe('Hi {first_name}, ann@x.test {nope}')
  })

  it('turns plain text into safe editor HTML', () => {
    expect(snippetHtml('a < b & c\nnext')).toBe('a &lt; b &amp; c<br>next')
  })

  it('finds a ;shortcut right before the caret, at a word start only', () => {
    expect(shortcutBeforeCaret(';thx')).toBe('thx')
    expect(shortcutBeforeCaret('Hello ;thx')).toBe('thx')
    expect(shortcutBeforeCaret('Hello ;thx')).toBe('thx')
    expect(shortcutBeforeCaret('a;thx')).toBeNull()
    expect(shortcutBeforeCaret(';thx ')).toBeNull()
    expect(shortcutBeforeCaret('Hello')).toBeNull()
  })
})
```

  In `src/ui/commands.test.ts`, add:

```ts
  it('declares ⌘; as the compose snippet picker', () => {
    expect(COMMANDS.find((c) => c.id === 'compose.snippet')).toMatchObject({
      external: true,
      keys: [{ kind: 'mod', key: ';', modes: ['compose'] }]
    })
  })
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/core/store/snippets.test.ts src/ui/snippetVars.test.ts src/ui/commands.test.ts`. Expected: FAIL.

- [x] **Step 3: Create `src/core/store/snippets.ts`.**

```ts
import { getDb } from './db.js'

/** A plain-text template with {variables}; global, like splits. */
export interface Snippet {
  id: number
  name: string
  /** Typed after `;` in the compose body, then ⇥. */
  shortcut: string | null
  body: string
  created_at: number
  updated_at: number
}

const SHORTCUT_RE = /^[a-z0-9_-]{1,24}$/i

export function listSnippets(): Snippet[] {
  return getDb().prepare('SELECT * FROM snippets ORDER BY lower(name), id').all() as Snippet[]
}

export function saveSnippet(input: { id?: number; name: string; shortcut?: string | null; body: string }): Snippet {
  const name = input.name.trim()
  const body = input.body.replace(/\s+$/, '')
  const shortcut = input.shortcut?.trim().replace(/^;/, '') || null
  if (!name || !body.trim()) throw new Error('A snippet needs a name and some text')
  if (shortcut && !SHORTCUT_RE.test(shortcut)) throw new Error('Shortcut: letters, digits, - or _, up to 24')
  const db = getDb()
  const now = Date.now()
  try {
    if (input.id) {
      db.prepare('UPDATE snippets SET name = ?, shortcut = ?, body = ?, updated_at = ? WHERE id = ?').run(
        name,
        shortcut,
        body,
        now,
        input.id
      )
      return db.prepare('SELECT * FROM snippets WHERE id = ?').get(input.id) as Snippet
    }
    return db
      .prepare(
        'INSERT INTO snippets (name, shortcut, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *'
      )
      .get(name, shortcut, body, now, now) as Snippet
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) throw new Error(`;${shortcut} is already used by another snippet`)
    throw e
  }
}

export function deleteSnippet(id: number): void {
  getDb().prepare('DELETE FROM snippets WHERE id = ?').run(id)
}
```

- [x] **Step 4: Create `src/ui/snippetVars.ts`.**

```ts
export interface SnippetContext {
  to: string
  me: { name: string | null; email: string | null }
  now: Date
}

function firstRecipient(to: string): { name: string; email: string } {
  const first = to.split(/[,;]/).map((s) => s.trim()).find(Boolean) ?? ''
  const m = /^(.*?)<([^>]+)>\s*$/.exec(first)
  const name = (m ? m[1] : '').trim().replace(/^"|"$/g, '').trim()
  return { name, email: (m ? m[2] : first).trim() }
}

/** The variables a snippet can use. Recipient ones read the first To address. */
export function snippetVars(ctx: SnippetContext): Record<string, string> {
  const r = firstRecipient(ctx.to)
  const [first = '', ...rest] = r.name.split(/\s+/).filter(Boolean)
  const myName = ctx.me.name?.trim() ?? ''
  return {
    first_name: first,
    last_name: rest.join(' '),
    name: r.name,
    email: r.email,
    my_name: myName,
    my_first_name: myName.split(/\s+/)[0] ?? '',
    my_email: ctx.me.email ?? '',
    date: ctx.now.toLocaleDateString(),
    day: ctx.now.toLocaleDateString(undefined, { weekday: 'long' })
  }
}

/** Replaces {variables}, any case. Unknown or empty ones stay as typed, so a missing name shows instead of a blank. */
export function expandSnippet(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key.toLowerCase()] || whole)
}

/** Plain snippet text as editor HTML: escaped, line breaks kept. */
export function snippetHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>')
}

/** The `;shortcut` just before the caret, when it starts a word. */
export function shortcutBeforeCaret(textBefore: string): string | null {
  const m = /(?:^|\s);([a-z0-9_-]{1,24})$/i.exec(textBefore)
  return m ? m[1] : null
}
```

- [x] **Step 5: IPC and preload.** In `electron/ipcPower.ts`, import `deleteSnippet, listSnippets, saveSnippet` from `'../src/core/store/snippets.js'` and add inside `registerPowerIpc`:

```ts
  ipcMain.handle('snippets:list', () => listSnippets())
  ipcMain.handle('snippets:save', (_e, input: { id?: number; name: string; shortcut?: string | null; body: string }) => {
    try {
      return { ok: true as const, snippet: saveSnippet(input) }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })
  ipcMain.handle('snippets:delete', (_e, id: number) => {
    deleteSnippet(id)
    return { ok: true as const }
  })
```

  In `electron/preload.ts`, add the type and methods:

```ts
export interface Snippet {
  id: number
  name: string
  shortcut: string | null
  body: string
  created_at: number
  updated_at: number
}
```

```ts
  listSnippets: (): Promise<Snippet[]> => ipcRenderer.invoke('snippets:list'),
  saveSnippet: (input: {
    id?: number
    name: string
    shortcut?: string | null
    body: string
  }): Promise<{ ok: true; snippet: Snippet } | { ok: false; error: string }> => ipcRenderer.invoke('snippets:save', input),
  deleteSnippet: (id: number): Promise<{ ok: true }> => ipcRenderer.invoke('snippets:delete', id),
```

- [x] **Step 6: Register `⌘;`.** In `src/ui/commands.ts`, add `'compose.snippet'` to `CommandId` and after `compose.focusSubject`:

```ts
  { id: 'compose.snippet', title: 'Insert snippet…', group: 'Compose', external: true, keys: [{ kind: 'mod', key: ';', modes: ['compose'] }] },
```

- [x] **Step 7: The caret, collapsed or not.** Append to `src/ui/richText.ts`:

```ts
/** The caret or selection inside `el`. captureSelection ignores a bare caret; a snippet goes exactly there. */
export function captureCaret(el: HTMLElement | null): Range | null {
  const sel = window.getSelection()
  if (!el || !sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  return el.contains(range.commonAncestorContainer) ? range.cloneRange() : null
}
```

- [x] **Step 8: Compose.** In `src/ui/views/Compose.tsx`:
  - Imports: `type KeyboardEvent as ReactKeyboardEvent` from `'react'`; `captureCaret` from `'../richText'`; `expandSnippet, shortcutBeforeCaret, snippetHtml, snippetVars` from `'../snippetVars'`; `Picker` from `'./Picker'`; `type Snippet` from `'../../../electron/preload'`.
  - Prop: `/** You, for {my_name} / {my_email}. */ me: { name: string | null; email: string | null }`.
  - State and loading:

```ts
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [pickingSnippet, setPickingSnippet] = useState(false)
  const caretRef = useRef<Range | null>(null)
  useEffect(() => {
    void window.api.listSnippets().then(setSnippets)
  }, [])

  /** Inserts at the current selection, which the caller has placed. */
  const insertSnippet = useCallback(
    (s: Snippet) => {
      const text = expandSnippet(s.body, snippetVars({ to: compose.to, me, now: new Date() }))
      document.execCommand('insertHTML', false, snippetHtml(text))
      const el = editorRef.current
      if (el) updateCompose({ body: el.innerHTML })
    },
    [compose.to, me, updateCompose]
  )

  /** `;thx` then ⇥ expands in place. Any other Tab keeps its normal meaning. */
  const onEditorKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      const sel = window.getSelection()
      if (!sel || !sel.rangeCount || !sel.isCollapsed) return
      const range = sel.getRangeAt(0)
      const node = range.startContainer
      if (node.nodeType !== Node.TEXT_NODE || !editorRef.current?.contains(node)) return
      const shortcut = shortcutBeforeCaret((node.textContent ?? '').slice(0, range.startOffset))
      if (!shortcut) return
      const snip = snippets.find((s) => s.shortcut?.toLowerCase() === shortcut.toLowerCase())
      if (!snip) return
      e.preventDefault()
      const typed = document.createRange()
      typed.setStart(node, range.startOffset - shortcut.length - 1)
      typed.setEnd(node, range.startOffset)
      sel.removeAllRanges()
      sel.addRange(typed)
      insertSnippet(snip)
    },
    [snippets, insertSnippet]
  )

  const pickSnippet = useCallback(
    (id: string) => {
      setPickingSnippet(false)
      const snip = snippets.find((s) => String(s.id) === id)
      const el = editorRef.current
      if (!snip || !el) return
      el.focus()
      const sel = window.getSelection()
      if (!sel) return
      sel.removeAllRanges()
      if (caretRef.current) sel.addRange(caretRef.current)
      else {
        const end = document.createRange()
        end.selectNodeContents(el)
        end.collapse(false)
        sel.addRange(end)
      }
      insertSnippet(snip)
    },
    [snippets, insertSnippet]
  )
```

  - Add to `chords` (and `pickSnippet`'s inputs are already in scope; nothing new in its deps):

```ts
      {
        key: ';',
        handler: () => {
          caretRef.current = captureCaret(editorRef.current)
          setPickingSnippet(true)
        }
      },
```

  - Escape effect: also skip when `pickingSnippet` (add it to the deps).
  - On the editor `<div className="compose-body" …>` add `onKeyDown={onEditorKeyDown}`.
  - Render the picker next to the other pickers:

```tsx
      {pickingSnippet && (
        <Picker
          title="Insert snippet"
          items={snippets.map((s) => ({ id: String(s.id), label: s.shortcut ? `${s.name}  ;${s.shortcut}` : s.name }))}
          emptyText="No snippets yet. Add them in Settings → Snippets."
          onPick={pickSnippet}
          onClose={() => setPickingSnippet(false)}
        />
      )}
```

  In `src/ui/App.tsx`, pass `me` to `<Compose>`:

```tsx
          <Compose
            compose={compose}
            me={(() => {
              const a = accounts.find((x) => x.accountId === (compose.accountId ?? activeAccountId))
              return { name: a?.name ?? null, email: a?.email ?? email }
            })()}
            onClose={closeCompose}
            onSent={onSent}
          />
```

- [x] **Step 9: Settings → Snippets.** Create `src/ui/views/SnippetSettings.tsx`:

```tsx
import { useEffect, useState } from 'react'
import type { Snippet } from '../../../electron/preload'

const BLANK = { id: undefined as number | undefined, name: '', shortcut: '', body: '' }

/** Snippet editor. Variables: {first_name} {last_name} {name} {email} {my_name} {my_first_name} {my_email} {date} {day}. */
export function SnippetSettings() {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [draft, setDraft] = useState(BLANK)
  const [error, setError] = useState<string | null>(null)

  const reload = (): void => void window.api.listSnippets().then(setSnippets)
  useEffect(reload, [])

  const save = async (): Promise<void> => {
    const r = await window.api.saveSnippet({
      id: draft.id,
      name: draft.name,
      shortcut: draft.shortcut || null,
      body: draft.body
    })
    if (!r.ok) return setError(r.error)
    setError(null)
    setDraft(BLANK)
    reload()
  }

  return (
    <section className="settings-section">
      <h3>Snippets</h3>
      <p className="settings-hint">
        Type <code>;shortcut</code> then ⇥ in a message, or press ⌘; to pick one. Variables: {'{first_name}'},{' '}
        {'{name}'}, {'{email}'}, {'{my_name}'}, {'{date}'}, {'{day}'}.
      </p>
      <ul className="snippet-list">
        {snippets.map((s) => (
          <li key={s.id}>
            <button type="button" onClick={() => setDraft({ id: s.id, name: s.name, shortcut: s.shortcut ?? '', body: s.body })}>
              {s.name}
              {s.shortcut && <span className="snippet-key">;{s.shortcut}</span>}
            </button>
            <button
              type="button"
              aria-label={`Delete ${s.name}`}
              onClick={async () => {
                await window.api.deleteSnippet(s.id)
                if (draft.id === s.id) setDraft(BLANK)
                reload()
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="snippet-form">
        <input placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input placeholder="Shortcut (optional)" value={draft.shortcut} onChange={(e) => setDraft({ ...draft, shortcut: e.target.value })} />
        <textarea placeholder="Hi {first_name}, …" rows={4} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        {error && <p className="settings-error">{error}</p>}
        <div>
          <button type="button" onClick={() => void save()}>
            {draft.id ? 'Save snippet' : 'Add snippet'}
          </button>
          {draft.id && (
            <button type="button" onClick={() => setDraft(BLANK)}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
```

  Render `<SnippetSettings />` in `src/ui/views/Settings.tsx` after `<ShortcutSettings />`. Append to `src/ui/styles/app.css`:

```css
.snippet-list { list-style: none; margin: 0 0 8px; padding: 0; display: grid; gap: 2px; }
.snippet-list li { display: flex; justify-content: space-between; gap: 8px; }
.snippet-key { margin-left: 8px; color: var(--text-muted); font-size: 11.5px; }
.snippet-form { display: grid; gap: 6px; }
.settings-hint { font-size: 12px; color: var(--text-muted); margin: 0 0 8px; }
```

- [x] **Step 10: Run the tests, then the suite.** `pnpm exec vitest run src/core/store/snippets.test.ts src/ui` passes. `pnpm typecheck && pnpm test` green (**69 files**).

- [ ] **Step 11: Check in the app.** Add a snippet `thx` = `Thanks {first_name}!` in Settings. In a reply to "Ann Lee", type `;thx` then ⇥: it becomes "Thanks Ann!". `⌘;` opens the picker and inserts at the caret.

- [ ] **Step 12: Commit.**

```bash
git add src electron
git commit -m "[feat] snippets with variables, inline and from a picker"
```

---
### Task 9: Cancel a scheduled reply when someone replies first *(Scape)*

**Files:**
- Create: `src/core/send/cancelOnReply.ts`, `src/core/send/cancelOnReply.test.ts`
- Modify: `src/core/send/outbox.ts`, `src/core/pipeline/pipeline.ts`, `electron/ipc.ts`, `electron/main.ts`, `electron/preload.ts`, `src/ui/views/Compose.tsx`, `src/ui/views/TriageSettings.tsx`, `src/ui/App.tsx`

- [x] **Step 1: Write the failing tests.** Create `src/core/send/cancelOnReply.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { upsertMessage } from '../store/repo.js'
import { parseProcessor } from '../pipeline/parse.js'
import { runPipeline } from '../pipeline/pipeline.js'
import { enqueueOutbox, getOutbox } from './outbox.js'
import { cancelAndNotify, cancelScheduledOnReply, onScheduledCancelled, outboxThreadIds } from './cancelOnReply.js'

const ME = 'me@x.test'
const HOUR = 3_600_000
let uid = 0

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'cancelreply-')), 't.db'))
  uid = 0
  const db = getDb()
  db.prepare('INSERT INTO accounts (id,email) VALUES (1,?),(2,?)').run(ME, 'me2@y.test')
  db.prepare(
    `INSERT INTO folders (id,account_id,path,name,role) VALUES
       (1,1,'INBOX','INBOX','inbox'),(2,1,'Sent','Sent','sent'),(3,2,'INBOX','INBOX','inbox')`
  ).run()
  // The conversations the scheduled replies answer, received yesterday.
  msg({ id: '<a@z>', thread: '<a@z>', from: 'ann@z.test', date: Date.now() - 24 * HOUR })
  msg({ id: '<b@z>', thread: '<b@z>', from: 'bob@z.test', date: Date.now() - 24 * HOUR })
})

function msg(o: {
  account?: number
  folder?: number
  id: string
  thread: string
  from: string
  inReplyTo?: string | null
  date?: number
}): number {
  uid++
  return upsertMessage({
    account_id: o.account ?? 1,
    folder_id: o.folder ?? 1,
    uid,
    message_id: o.id,
    thread_id: o.thread,
    in_reply_to: o.inReplyTo ?? null,
    from_addr: o.from,
    from_name: null,
    to_addrs: '[]',
    cc_addrs: '[]',
    subject: 'Re: plan',
    date: o.date ?? Date.now() + 60_000,
    snippet: null
  })
}

function schedule(o: { account?: number; inReplyTo: string; refs?: string; cancel?: boolean; sendAt?: number }) {
  return enqueueOutbox({
    account_id: o.account ?? 1,
    draft_message_id: null,
    to_addrs: 'them@z.test',
    subject: 'Re: plan',
    in_reply_to: o.inReplyTo,
    references_header: o.refs ?? o.inReplyTo,
    send_at: o.sendAt ?? Date.now() + HOUR,
    cancel_on_reply: o.cancel === false ? 0 : 1
  })
}

const status = (id: number) => getOutbox(id)?.status

describe('cancel a scheduled reply on a reply', () => {
  it('cancels the scheduled reply on the thread someone answered, and only that one', () => {
    const a = schedule({ inReplyTo: '<a@z>' })
    const b = schedule({ inReplyTo: '<b@z>' })
    const reply = msg({ id: '<a2@z>', thread: '<a@z>', from: 'carl@z.test', inReplyTo: '<a@z>' })
    expect(cancelScheduledOnReply(reply)).toEqual([
      { outboxId: a.id, accountId: 1, subject: 'Re: plan', to: 'them@z.test' }
    ])
    expect([status(a.id), status(b.id)]).toEqual(['cancelled', 'pending'])
  })

  it('finds the thread through References when the replied-to message is not local', () => {
    const a = schedule({ inReplyTo: '<gone@z>', refs: '<a@z> <gone@z>' })
    const reply = msg({ id: '<a3@z>', thread: '<a@z>', from: 'carl@z.test' })
    expect(cancelScheduledOnReply(reply).map((c) => c.outboxId)).toEqual([a.id])
  })

  it('leaves my own mail, opted-out rows, due rows and older mail alone', () => {
    const a = schedule({ inReplyTo: '<a@z>' })
    const off = schedule({ inReplyTo: '<a@z>', cancel: false })
    const due = schedule({ inReplyTo: '<a@z>', sendAt: Date.now() - 1 })
    expect(cancelScheduledOnReply(msg({ id: '<m1@x>', thread: '<a@z>', from: 'ME@x.test' }))).toEqual([])
    expect(cancelScheduledOnReply(msg({ id: '<m2@x>', thread: '<a@z>', from: 'carl@z.test', folder: 2 }))).toEqual([])
    expect(
      cancelScheduledOnReply(msg({ id: '<old@z>', thread: '<a@z>', from: 'carl@z.test', date: Date.now() - HOUR }))
    ).toEqual([])
    expect([status(a.id), status(off.id), status(due.id)]).toEqual(['pending', 'pending', 'pending'])
  })

  it('stays inside the account', () => {
    const a = schedule({ inReplyTo: '<a@z>' })
    const other = msg({ account: 2, folder: 3, id: '<a4@z>', thread: '<a@z>', from: 'carl@z.test' })
    expect(cancelScheduledOnReply(other)).toEqual([])
    expect(status(a.id)).toBe('pending')
  })

  it('reads the ids a send is threaded on', () => {
    expect(outboxThreadIds({ in_reply_to: '<b@z>', references_header: '<a@z>  <b@z> junk' })).toEqual(['<b@z>', '<a@z>'])
    expect(outboxThreadIds({ in_reply_to: null, references_header: null })).toEqual([])
  })

  it('runs after the pipeline stores a synced reply, and tells listeners', async () => {
    const a = schedule({ inReplyTo: '<a@z>' })
    const seen: number[] = []
    const off = onScheduledCancelled((c) => seen.push(...c.map((x) => x.outboxId)))
    try {
      await runPipeline(
        {
          accountId: 1,
          folderId: 1,
          uid: 99,
          envelope: {
            messageId: '<a5@z>',
            inReplyTo: '<a@z>',
            references: ['<a@z>'],
            from: { address: 'carl@z.test' },
            subject: 'Re: plan',
            date: new Date(Date.now() + 60_000)
          },
          flags: []
        },
        [parseProcessor]
      )
      expect(status(a.id)).toBe('cancelled')
      expect(seen).toEqual([a.id])
      // Already cancelled: a second pass (the body fetch) reports nothing.
      expect(cancelAndNotify(getDb().prepare("SELECT id FROM messages WHERE message_id = '<a5@z>'").pluck().get() as number)).toEqual([])
    } finally {
      off()
    }
  })
})
```

- [x] **Step 2: Run it and confirm it fails.** `pnpm exec vitest run src/core/send/cancelOnReply.test.ts`. Expected: FAIL (missing module; `cancel_on_reply` unknown to `enqueueOutbox`).

- [x] **Step 3: Carry the flag on the outbox.** In `src/core/send/outbox.ts`:
  - `OutboxRow` gains `/** 1: cancel this scheduled send if someone replies to its thread first. */ cancel_on_reply: number`.
  - `EnqueueOutboxInput` gains `cancel_on_reply?: number`.
  - `enqueueOutbox`'s INSERT adds the column `cancel_on_reply` / `@cancel_on_reply`, with `cancel_on_reply: input.cancel_on_reply ?? 0` in `.run({...})`.

- [x] **Step 4: Create `src/core/send/cancelOnReply.ts`.**

```ts
import { getDb } from '../store/db.js'
import { cancelOutbox } from './outbox.js'

export interface CancelledSend {
  outboxId: number
  accountId: number
  subject: string | null
  to: string
}

/** Mail in these folders is not someone answering you. */
const NOT_A_REPLY = new Set(['sent', 'drafts', 'trash', 'junk'])
const VALID_ID = /^<[^<>\s]+>$/

/** The Message-IDs a send is threaded on: what it replies to, then its References. */
export function outboxThreadIds(row: { in_reply_to: string | null; references_header: string | null }): string[] {
  const refs = (row.references_header ?? '').split(/\s+/)
  return [...new Set([row.in_reply_to ?? '', ...refs].filter((x) => VALID_ID.test(x)))]
}

interface Stored {
  account_id: number
  thread_id: string | null
  in_reply_to: string | null
  date: number | null
  from_l: string
  role: string | null
  me: string
}

interface Pending {
  id: number
  account_id: number
  subject: string | null
  to_addrs: string
  in_reply_to: string | null
  references_header: string | null
  created_at: number
}

/**
 * Called after a synced message is stored. Cancels every pending scheduled
 * send of the same account that opted in, belongs to this message's thread,
 * and was scheduled before the message was sent. Local only, like the outbox:
 * it works while the app runs and syncs.
 */
export function cancelScheduledOnReply(messageRowId: number, now = Date.now()): CancelledSend[] {
  const db = getDb()
  const m = db
    .prepare(
      `SELECT m.account_id, m.thread_id, m.in_reply_to, m.date,
              lower(COALESCE(m.from_addr, '')) AS from_l, f.role, lower(a.email) AS me
         FROM messages m
         JOIN accounts a ON a.id = m.account_id
         JOIN folders f ON f.id = m.folder_id
        WHERE m.id = ?`
    )
    .get(messageRowId) as Stored | undefined
  if (!m || m.from_l === m.me || NOT_A_REPLY.has(m.role ?? '')) return []
  const pending = db
    .prepare(
      `SELECT id, account_id, subject, to_addrs, in_reply_to, references_header, created_at FROM outbox
        WHERE account_id = ? AND status = 'pending' AND cancel_on_reply = 1 AND send_at > ?`
    )
    .all(m.account_id, now) as Pending[]
  const out: CancelledSend[] = []
  for (const row of pending) {
    // An old message re-synced is not an answer to a send scheduled after it.
    if ((m.date ?? now) <= row.created_at) continue
    const ids = outboxThreadIds(row)
    if (!ids.length) continue
    const keys = new Set<string>(ids)
    const threads = db
      .prepare(
        `SELECT DISTINCT thread_id FROM messages
          WHERE account_id = ? AND thread_id IS NOT NULL AND message_id IN (${ids.map(() => '?').join(',')})`
      )
      .all(m.account_id, ...ids) as { thread_id: string }[]
    for (const t of threads) keys.add(t.thread_id)
    const sameThread =
      (m.thread_id !== null && keys.has(m.thread_id)) || (m.in_reply_to !== null && ids.includes(m.in_reply_to))
    if (sameThread && cancelOutbox(row.id))
      out.push({ outboxId: row.id, accountId: row.account_id, subject: row.subject, to: row.to_addrs })
  }
  return out
}

type Listener = (cancelled: CancelledSend[]) => void
const listeners = new Set<Listener>()

/** Main subscribes to tell the renderer; returns the unsubscribe. */
export function onScheduledCancelled(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** cancelScheduledOnReply, then tell every listener about what it cancelled. */
export function cancelAndNotify(messageRowId: number): CancelledSend[] {
  const cancelled = cancelScheduledOnReply(messageRowId)
  if (cancelled.length) for (const l of listeners) l(cancelled)
  return cancelled
}
```

- [x] **Step 5: Hook the pipeline.** In `src/core/pipeline/pipeline.ts`, import `cancelAndNotify` from `'../send/cancelOnReply.js'`, and between the transaction and `return { id, errors }` add:

```ts
  // A reply that lands before a scheduled reply goes out cancels it (opt-in
  // per send). Never allowed to cost the message: errors are recorded only.
  if (id !== null && raw.folderId !== null) {
    try {
      cancelAndNotify(id)
    } catch (e) {
      errors.push({ processor: 'cancelOnReply', message: (e as Error).message })
    }
  }
```

- [x] **Step 6: Main, preload, compose.**
  - `electron/preload.ts`: add `/** Scheduled send only: cancel it if someone replies first. */ cancelOnReply?: boolean` to `QueueSendPayload`, and:

```ts
  onSendCancelledOnReply: (
    cb: (c: { outboxId: number; accountId: number; subject: string | null; to: string }[]) => void
  ): (() => void) => {
    const h = (_e: unknown, c: { outboxId: number; accountId: number; subject: string | null; to: string }[]): void => cb(c)
    ipcRenderer.on('send:cancelledOnReply', h)
    return () => ipcRenderer.off('send:cancelledOnReply', h)
  },
```

  - `electron/ipc.ts`, `compose:queueSend`: add `cancel_on_reply: payload.cancelOnReply && payload.inReplyTo ? 1 : 0` to the `enqueueOutbox({...})` input.
  - `electron/main.ts`: import `onScheduledCancelled` from `'../src/core/send/cancelOnReply.js'` and, after `onReauthRequired(...)`:

```ts
  onScheduledCancelled((cancelled) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('send:cancelledOnReply', cancelled)
  })
```

  - `src/ui/views/Compose.tsx`: add the prop `cancelOnReplyDefault: boolean`; `persistAndQueue`'s options become `{ done?: boolean; cancelOnReply?: boolean }` and the `queueSend` payload gets `cancelOnReply: !!opts.cancelOnReply`; the send-later picker becomes:

```tsx
      {laterOpen && (
        <RemindPicker
          title="Send later"
          // Only a reply has a thread someone could answer before it goes out.
          showCheck={!!compose.inReplyTo}
          checkLabel="Cancel if someone replies first"
          defaultIfNoReply={cancelOnReplyDefault}
          onPick={(at, cancelOnReply) => {
            setLaterOpen(false)
            void persistAndQueue(at, { cancelOnReply })
          }}
          onClose={() => setLaterOpen(false)}
        />
      )}
```

- [x] **Step 7: Settings default and the notice.**
  - `src/ui/views/TriageSettings.tsx`: add `const [cancelDefault, setCancelDefault] = useState(false)`; in the mount effect's `getSettings` callback add `setCancelDefault(s.cancel_on_reply_default === '1')`; append as the **last** section of the returned JSX (`folders.test.ts` reads the Done-folder section by offset):

```tsx
      <section className="settings-section">
        <h3>Scheduled sends</h3>
        <label className="picker-check">
          <input
            type="checkbox"
            checked={cancelDefault}
            onChange={(e) => {
              setCancelDefault(e.target.checked)
              void window.api.setSettings({ cancel_on_reply_default: e.target.checked ? '1' : '0' })
            }}
          />
          Cancel a scheduled reply when someone replies first
        </label>
      </section>
```

  - `src/ui/App.tsx`: `const [cancelOnReplyDefault, setCancelOnReplyDefault] = useState(false)`, set from `s.cancel_on_reply_default === '1'` both in the mount settings effect and where the keymap is reloaded on Settings close; pass `cancelOnReplyDefault={cancelOnReplyDefault}` to `<Compose>`. In the effect that subscribes to `onSendFailed`, add:

```ts
    const offCancelled = window.api.onSendCancelledOnReply((c) => {
      setActionError(
        c.length === 1
          ? `Scheduled reply “${c[0].subject || '(no subject)'}” cancelled: someone replied first`
          : `${c.length} scheduled replies cancelled: someone replied first`
      )
    })
```

    and call `offCancelled()` in that effect's cleanup.

- [x] **Step 8: Run the tests, then the suite.** `pnpm exec vitest run src/core/send src/core/pipeline` passes. `pnpm typecheck && pnpm test` green (**70 files**).

- [ ] **Step 9: Commit.**

```bash
git add src electron
git commit -m "[feat] cancel a scheduled reply when someone replies first"
```

---

### Task 10: Search operators and Gmail server search

`OR`, `-term`, `-from:x`, `"phrase"`, `in:`, `label:`, `before:` / `after:` in `search.ts`, for the ⌘K search, the search page and list views alike. Gmail accounts can also search the server with `X-GM-RAW` and store what is not local yet.

**Files:**
- Create: `src/core/store/searchOps.test.ts`, `src/core/sync/serverSearch.ts`, `src/core/sync/serverSearch.test.ts`
- Modify: `src/core/store/search.ts`, `src/core/store/listQuery.test.ts`, `src/core/sync/syncEngine.ts`, `electron/ipcPower.ts`, `electron/preload.ts`

- [x] **Step 1: Write the failing tests.** Create `src/core/store/searchOps.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import { upsertMessage } from './repo.js'
import { searchMessages } from './search.js'

let uid = 0

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'searchops-')), 't.db'))
  uid = 0
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test'),(2,'you@y.test')").run()
  db.prepare(
    `INSERT INTO folders (id,account_id,path,name,role) VALUES
       (1,1,'INBOX','INBOX','inbox'),(2,1,'Archive','Archive','archive'),
       (3,1,'Projects','Projects',NULL),(4,2,'INBOX','INBOX','inbox')`
  ).run()
})

function add(o: { subject: string; body?: string; from?: string; folder?: number; account?: number; date?: number }): number {
  uid++
  return upsertMessage({
    account_id: o.account ?? 1,
    folder_id: o.folder ?? 1,
    uid,
    message_id: `<s${uid}@t>`,
    thread_id: `<s${uid}@t>`,
    in_reply_to: null,
    from_addr: o.from ?? 'x@z.test',
    from_name: null,
    to_addrs: '[]',
    cc_addrs: '[]',
    subject: o.subject,
    date: o.date ?? uid * 1000,
    snippet: null,
    body_text: o.body ?? null
  })
}

const ids = (q: string, account = 1) =>
  searchMessages(account, q)
    .map((r) => r.id)
    .sort((a, b) => a - b)

describe('search operators', () => {
  it('ORs terms and operators, Gmail-style (OR binds tighter than AND)', () => {
    const a = add({ subject: 'invoice march', from: 'ann@z.test' })
    const b = add({ subject: 'receipt april', from: 'bob@z.test' })
    add({ subject: 'hello', from: 'cy@z.test' })
    expect(ids('invoice OR receipt')).toEqual([a, b])
    expect(ids('from:ann OR from:bob')).toEqual([a, b])
    expect(ids('march invoice OR receipt')).toEqual([a])
  })

  it('drops a -term and a -operator', () => {
    add({ subject: 'invoice march', from: 'ann@z.test' })
    const may = add({ subject: 'invoice may', from: 'bob@z.test' })
    expect(ids('invoice -march')).toEqual([may])
    expect(ids('invoice -from:ann')).toEqual([may])
  })

  it('matches a "phrase" as words in that order', () => {
    const a = add({ subject: 'quarterly report due' })
    add({ subject: 'report on the quarterly numbers' })
    expect(ids('"quarterly report"')).toEqual([a])
  })

  it('filters in: by role or folder name; in:done means the Done folder', () => {
    const inbox = add({ subject: 'plan' })
    const done = add({ subject: 'plan', folder: 2 })
    const proj = add({ subject: 'plan', folder: 3 })
    expect(ids('plan in:inbox')).toEqual([inbox])
    expect(ids('plan in:done')).toEqual([done])
    expect(ids('plan in:projects')).toEqual([proj])
  })

  it('filters label: on the Gmail labels of the same account', () => {
    const a = add({ subject: 'plan' })
    add({ subject: 'plan' })
    const db = getDb()
    const label = Number(db.prepare("INSERT INTO labels (account_id, name) VALUES (1, 'Work')").run().lastInsertRowid)
    db.prepare('INSERT INTO message_labels (message_id, label_id) VALUES (?, ?)').run(a, label)
    expect(ids('label:work')).toEqual([a])
    expect(ids('plan -label:Work').length).toBe(1)
  })

  it('filters before: and after: by day, and treats a bad date as text', () => {
    const jan10 = add({ subject: 'plan', date: new Date(2026, 0, 10, 12).getTime() })
    const jan20 = add({ subject: 'plan', date: new Date(2026, 0, 20, 12).getTime() })
    expect(ids('plan after:2026/01/15')).toEqual([jan20])
    expect(ids('plan before:2026-01-15')).toEqual([jan10])
    expect(ids('after:2026/01/20')).toEqual([jan20])
    expect(ids('plan before:2026-13-40')).toEqual([])
  })

  it('keeps every search inside its account', () => {
    const mine = add({ subject: 'budget' })
    add({ subject: 'budget', account: 2, folder: 4 })
    expect(ids('budget OR nothing')).toEqual([mine])
  })
})
```

  Append to `src/core/store/listQuery.test.ts`:

```ts
describe('the split-query parser, new operators', () => {
  it('groups OR operands, thread-state ones included', () => {
    const w = listWhere('is:unread OR is:starred')
    expect(w.sql).toBe(' AND (lr.unread_count > 0 OR lr.flagged = 1)')
    expect(w.params).toEqual([])
  })

  it('keeps bare words and phrases in one FTS match', () => {
    expect(listWhere('invoice "due soon"')).toEqual({
      sql: ' AND m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)',
      params: ['"invoice"* "due soon"']
    })
  })

  it('reads a negated operator as NOT', () => {
    expect(parseQuery('-is:unread', 'list').predicates).toEqual([{ sql: 'NOT (lr.unread_count > 0)', params: [] }])
  })
})
```

  Create `src/core/sync/serverSearch.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { gmailRawQuery, missingUids } from './serverSearch.js'

describe('gmailRawQuery', () => {
  it('drops the operators only the local list understands', () => {
    expect(gmailRawQuery('from:ann is:needs-reply invoice')).toBe('from:ann invoice')
    expect(gmailRawQuery('-is:waiting x OR y')).toBe('x OR y')
    expect(gmailRawQuery('is:unread has:attachment')).toBe('is:unread has:attachment')
  })
})

describe('missingUids', () => {
  beforeEach(() => {
    closeDb()
    initDb(join(mkdtempSync(join(tmpdir(), 'serversearch-')), 't.db'))
    const db = getDb()
    db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@gmail.com')").run()
    db.prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox')").run()
    const ins = db.prepare(
      "INSERT INTO messages (account_id, folder_id, uid, message_id, flags) VALUES (1, 1, ?, ?, '[]')"
    )
    ins.run(5, '<5@t>')
    ins.run(7, '<7@t>')
  })

  it('keeps server hits with no local row, newest first, capped', () => {
    expect(missingUids(1, [9, 5, 8, 7, 9], 2)).toEqual([9, 8])
    expect(missingUids(1, [5, 7], 10)).toEqual([])
    expect(missingUids(1, [], 10)).toEqual([])
  })
})
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/core/store/searchOps.test.ts src/core/store/listQuery.test.ts src/core/sync/serverSearch.test.ts`. Expected: FAIL.

- [x] **Step 3: Rewrite the parser in `src/core/store/search.ts`.** Delete the old `TOKEN_RE`, the old `interface Parsed` and the old `parseQuery`. Keep `TEXT_FIELDS`, `TEXT_COLS`, `hasFlagSql`, `likeParam`, `QueryContext`, `VIP_SQL`, `REPLIED_SQL`, `IMPORTANT_SQL` and `LIST_IS` as they are. Insert, where the old `parseQuery` was:

```ts
/** Optional `-`, then `field:value`, `field:"quoted value"`, `"a phrase"`, or a bare term. */
const TOKEN_RE = /(-?)(?:(\w+):("([^"]*)"|\S+)|"([^"]*)"|(\S+))/g

type Pred = { sql: string; params: unknown[] }

interface Parsed {
  /** Positive bare words: one FTS match with phrases, prefix-matching the last word. */
  terms: string[]
  /** Positive "phrases": words in order. */
  phrases: string[]
  /** Everything else, ANDed: field operators, negations, OR groups. */
  predicates: Pred[]
}

type Atom =
  | { kind: 'term'; text: string }
  | { kind: 'phrase'; text: string }
  | { kind: 'pred'; pred: Pred }
  | { kind: 'or'; parts: Atom[] }

const FTS_IN = 'm.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)'

/** in: names that mean a role. Done is Archive, or All Mail on Gmail. */
const IN_ROLES: Record<string, string[]> = {
  inbox: ['inbox'],
  sent: ['sent'],
  drafts: ['drafts'],
  trash: ['trash'],
  bin: ['trash'],
  spam: ['junk'],
  junk: ['junk'],
  done: ['archive', 'all'],
  archive: ['archive', 'all']
}

/** YYYY-MM-DD or YYYY/MM/DD as local midnight, or null for anything else. */
export function parseDay(v: string): number | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d.getTime() : null
}

/** FTS5 phrase: the words in order, no prefix match. */
export function toFtsPhrase(input: string): string {
  const tokens = input.match(/[\p{L}\p{N}]+/gu)
  return tokens?.length ? `"${tokens.join(' ')}"` : ''
}

/** A recognised `field:value`, or null to treat the token as text. */
function operatorPred(field: string, value: string, ctx: QueryContext): Pred | null {
  if (!value) return null
  if (TEXT_FIELDS.has(field))
    return { sql: `lower(${TEXT_COLS[field]}) LIKE ? ESCAPE '\\'`, params: [likeParam(value)] }
  const v = value.toLowerCase()
  if (field === 'is') {
    if (ctx === 'list' && Object.hasOwn(LIST_IS, v)) return { sql: LIST_IS[v], params: [] }
    if (v === 'unread' || v === 'read') {
      const f = hasFlagSql('\\seen')
      return { sql: v === 'read' ? f.sql : `NOT ${f.sql}`, params: f.params }
    }
    if (v === 'starred' || v === 'flagged') return hasFlagSql('\\flagged')
    return null
  }
  if (field === 'has') return v === 'attachment' || v === 'attachments' ? { sql: 'm.has_attachments = 1', params: [] } : null
  if (field === 'in') {
    const roles = IN_ROLES[v]
    if (roles)
      return {
        sql: `m.folder_id IN (SELECT f.id FROM folders f WHERE f.account_id = m.account_id AND f.role IN (${roles.map(() => '?').join(',')}))`,
        params: roles
      }
    return {
      sql: 'm.folder_id IN (SELECT f.id FROM folders f WHERE f.account_id = m.account_id AND (lower(f.name) = ? OR lower(f.path) = ?))',
      params: [v, v]
    }
  }
  if (field === 'label')
    return {
      sql: `EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id
                     WHERE ml.message_id = m.id AND l.account_id = m.account_id AND lower(l.name) = ?)`,
      params: [v]
    }
  if (field === 'before' || field === 'after') {
    const t = parseDay(value)
    if (t === null) return null
    return field === 'before' ? { sql: 'm.date < ?', params: [t] } : { sql: 'm.date >= ?', params: [t] }
  }
  return null
}

function atomPred(a: Atom): Pred | null {
  if (a.kind === 'pred') return a.pred
  if (a.kind === 'term') {
    const fts = toFtsQuery(a.text)
    return fts ? { sql: FTS_IN, params: [fts] } : null
  }
  if (a.kind === 'phrase') {
    const fts = toFtsPhrase(a.text)
    return fts ? { sql: FTS_IN, params: [fts] } : null
  }
  const parts = a.parts.map(atomPred).filter((p): p is Pred => p !== null)
  if (!parts.length) return null
  if (parts.length === 1) return parts[0]
  return { sql: `(${parts.map((p) => p.sql).join(' OR ')})`, params: parts.flatMap((p) => p.params) }
}

/** `-x`: a word or phrase must not appear (exact words, no prefix); an operator is NOTed. */
function negated(a: Atom): Atom | null {
  const p = a.kind === 'term' || a.kind === 'phrase' ? atomPred({ kind: 'phrase', text: a.text }) : atomPred(a)
  return p ? { kind: 'pred', pred: { sql: `NOT (${p.sql})`, params: p.params } } : null
}

/**
 * Split a query into FTS words / phrases and SQL predicates. Gmail syntax:
 * `a OR b` binds tighter than the implicit AND, `-` negates, quotes make a
 * phrase. Anything that isn't a recognised operator falls through as a
 * literal term, so `foo:bar` still searches.
 */
export function parseQuery(input: string, ctx: QueryContext = 'search'): Parsed {
  const items: (Atom | 'OR')[] = []
  for (const m of input.matchAll(TOKEN_RE)) {
    const neg = m[1] === '-'
    const field = m[2]?.toLowerCase()
    const value = m[4] ?? m[3] ?? ''
    const phrase = m[5]
    const bare = m[6]
    if (!neg && bare === 'OR') {
      items.push('OR')
      continue
    }
    let atom: Atom
    if (field) {
      const p = operatorPred(field, value, ctx)
      atom = p ? { kind: 'pred', pred: p } : { kind: 'term', text: m[0].slice(neg ? 1 : 0) }
    } else if (phrase !== undefined) atom = { kind: 'phrase', text: phrase }
    else atom = { kind: 'term', text: bare ?? '' }
    const final = neg ? negated(atom) : atom
    if (final) items.push(final)
  }

  // Fold `x OR y OR z` into one group. A dangling OR is ignored.
  const atoms: Atom[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it !== 'OR') {
      atoms.push(it)
      continue
    }
    const next = items[i + 1]
    const prev = atoms.pop()
    if (!prev || !next || next === 'OR') {
      if (prev) atoms.push(prev)
      continue
    }
    i++
    atoms.push({ kind: 'or', parts: [...(prev.kind === 'or' ? prev.parts : [prev]), next] })
  }

  const out: Parsed = { terms: [], phrases: [], predicates: [] }
  for (const a of atoms) {
    if (a.kind === 'term') out.terms.push(a.text)
    else if (a.kind === 'phrase') out.phrases.push(a.text)
    else {
      const p = atomPred(a)
      if (p) out.predicates.push(p)
    }
  }
  return out
}

/** The one FTS match a query's positive words and phrases make, or '' for none. */
export function ftsQueryOf(p: Pick<Parsed, 'terms' | 'phrases'>): string {
  return [toFtsQuery(p.terms.join(' ')), ...p.phrases.map(toFtsPhrase)].filter(Boolean).join(' ')
}
```

  Then:
  - In `searchMessages`, replace `const { terms, predicates } = parseQuery(query)` / `const fts = toFtsQuery(terms.join(' '))` with `const parsed = parseQuery(query)`, `const { terms, phrases, predicates } = parsed`, `const fts = ftsQueryOf(parsed)`; and change the fuzzy-fallback guard to `if (rows.length || predicates.length || phrases.length || !terms.length) return rows`.
  - In `listWhere`, replace `const { terms, predicates } = parseQuery(query, 'list')` / `const fts = toFtsQuery(terms.join(' '))` with `const parsed = parseQuery(query, 'list')`, `const { predicates } = parsed`, `const fts = ftsQueryOf(parsed)`.

  The `"invoice"*` expectation in `listQuery.test.ts` and every Phase 2 split / chip query keep working: single operators compile exactly as before.

- [x] **Step 4: Create `src/core/sync/serverSearch.ts`.**

```ts
import type { ImapFlow } from 'imapflow'
import { getDb } from '../store/db.js'

/** Operators only the local list understands; Gmail would read them as words. */
const LOCAL_ONLY = /(^|\s)-?is:(needs-reply|waiting|important|other|vip|bulk)(?=\s|$)/gi

/** The query to send as X-GM-RAW. Everything else is Gmail syntax already. */
export function gmailRawQuery(query: string): string {
  return query.replace(LOCAL_ONLY, ' ').replace(/\s+/g, ' ').trim()
}

/** Server hits with no local row in this folder, newest (highest uid) first, at most `limit`. */
export function missingUids(folderId: number, uids: number[], limit: number): number[] {
  if (!uids.length) return []
  const have = new Set(
    (
      getDb()
        .prepare(
          `SELECT uid FROM messages
            WHERE folder_id = ? AND uid IN (SELECT value FROM json_each(?))`
        )
        .all(folderId, JSON.stringify(uids)) as { uid: number }[]
    ).map((r) => r.uid)
  )
  return [...new Set(uids)]
    .filter((u) => !have.has(u))
    .sort((a, b) => b - a)
    .slice(0, limit)
}

/** X-GM-RAW search in one mailbox, as uids. */
export async function gmailSearchUids(client: ImapFlow, path: string, raw: string): Promise<number[]> {
  const lock = await client.getMailboxLock(path)
  try {
    const r = await client.search({ gmraw: raw }, { uid: true })
    return r || []
  } finally {
    lock.release()
  }
}
```

- [x] **Step 5: Fetch specific uids.** In `src/core/sync/syncEngine.ts`, after `backfillPage`, add:

```ts
/**
 * Fetches and stores the given uids (server-search hits) over an open
 * connection. Same envelope query as every other path, so they thread. The
 * sinceDays window does not apply: the user asked for them.
 */
export async function fetchUids(
  client: ImapFlow,
  accountId: number,
  folder: { id: number; path: string },
  uids: number[]
): Promise<number> {
  if (!uids.length) return 0
  const raw: RawMessage[] = []
  const lock = await client.getMailboxLock(folder.path)
  try {
    for await (const msg of client.fetch(uids.join(','), ENVELOPE_QUERY, { uid: true })) {
      raw.push(envelopeToRaw(msg, accountId, folder.id))
    }
  } finally {
    lock.release()
  }
  return store(raw, 0)
}
```

- [x] **Step 6: IPC and preload.** In `electron/ipcPower.ts` import `listFolders` from `'../src/core/store/repo.js'`, `shouldSyncFolder` from `'../src/core/sync/folderFilter.js'`, `getPool` from `'../src/core/sync/pool.js'`, `fetchUids` from `'../src/core/sync/syncEngine.js'` and `gmailRawQuery, gmailSearchUids, missingUids` from `'../src/core/sync/serverSearch.js'`, then add:

```ts
  // Gmail only: ask the server, store hits older than the local window, and
  // let the renderer search again. At most 50 new messages per folder per call.
  ipcMain.handle('search:server', async (_e, query: string) => {
    const raw = gmailRawQuery(query)
    if (!raw) return { ok: true as const, stored: 0 }
    let stored = 0
    for (const a of listAccounts()) {
      if (a.config.provider !== 'gmail') continue
      const folders = listFolders(a.accountId).filter((f) => shouldSyncFolder('gmail', f))
      try {
        stored += await getPool(a.config).withConnection(async (client) => {
          let n = 0
          for (const f of folders) {
            const want = missingUids(f.id, await gmailSearchUids(client, f.path, raw), 50)
            n += await fetchUids(client, a.accountId, f, want)
          }
          return n
        })
      } catch (e) {
        return { ok: false as const, error: (e as Error).message }
      }
    }
    return { ok: true as const, stored }
  })
```

  In `electron/preload.ts`:

```ts
  searchServer: (query: string): Promise<{ ok: true; stored: number } | { ok: false; error: string }> =>
    ipcRenderer.invoke('search:server', query),
```

- [x] **Step 7: Run the tests, then the suite.** `pnpm exec vitest run src/core/store src/core/sync` passes. `pnpm typecheck && pnpm test` green (**72 files**).

- [ ] **Step 8: Commit.**

```bash
git add src/core electron
git commit -m "[feat] OR, negation, phrases, in:, label:, dates in search; gmail server search"
```

---

### Task 11: The unified search page and the contact pane

One search page *(Scape)*: `/` opens it, with Emails (every account), Contacts and Tasks (active account) scopes; `Tab` switches scope, `↑↓↵` pick, `Esc` goes back. The thread view gains a contact pane: how much mail you have with this person and how often you reply, all from the local DB.

**Files:**
- Create: `src/core/store/searchAll.ts`, `src/core/store/searchAll.test.ts`, `src/core/store/contacts.ts`, `src/core/store/contacts.test.ts`, `src/ui/views/SearchPage.tsx`, `src/ui/views/ContactPane.tsx`
- Modify: `src/core/store/tasks.ts`, `src/core/store/tasks.test.ts`, `src/ui/hooks/useHotkeys.ts`, `src/ui/appMode.ts`, `src/ui/appMode.test.ts`, `src/ui/commands.ts`, `src/ui/commands.test.ts`, `src/ui/store.ts`, `src/ui/App.tsx`, `src/ui/views/Sidebar.tsx`, `electron/ipcPower.ts`, `electron/preload.ts`, `src/ui/styles/app.css`

- [x] **Step 1: Write the failing tests.** Create `src/core/store/searchAll.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { MessageListRow } from './types.js'
import { mergeByDate } from './searchAll.js'

const row = (id: number, date: number, account_id = 1) => ({ id, date, account_id }) as MessageListRow

describe('mergeByDate', () => {
  it('keeps one account in its relevance order', () => {
    expect(mergeByDate([[row(1, 10), row(2, 30)], []], 5).map((r) => r.id)).toEqual([1, 2])
  })
  it('merges several accounts newest first, capped', () => {
    expect(mergeByDate([[row(1, 10), row(2, 30)], [row(3, 20, 2)]], 2).map((r) => r.id)).toEqual([2, 3])
  })
})
```

  Create `src/core/store/contacts.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import { upsertMessage } from './repo.js'
import { contactProfile, threadCounterpart } from './contacts.js'

let uid = 0
const ids: Record<string, number> = {}

function add(key: string, o: { folder: number; thread: string; from: string; name?: string; to?: string[]; date: number }): void {
  uid++
  ids[key] = upsertMessage({
    account_id: 1,
    folder_id: o.folder,
    uid,
    message_id: `<${key}@t>`,
    thread_id: o.thread,
    in_reply_to: null,
    from_addr: o.from,
    from_name: o.name ?? null,
    to_addrs: JSON.stringify((o.to ?? []).map((address) => ({ address, name: null }))),
    cc_addrs: '[]',
    subject: key,
    date: o.date,
    snippet: null
  })
}

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'contacts-')), 't.db'))
  uid = 0
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
  db.prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox'),(2,1,'Sent','sent')").run()
  add('t1', { folder: 1, thread: '<t1>', from: 'ann@x.test', name: 'Ann', to: ['me@x.test'], date: 100 })
  add('t1reply', { folder: 2, thread: '<t1>', from: 'me@x.test', to: ['Ann@X.test'], date: 200 })
  add('t2', { folder: 1, thread: '<t2>', from: 'ann@x.test', to: ['me@x.test'], date: 300 })
  add('t3', { folder: 1, thread: '<t3>', from: 'bob@x.test', to: ['me@x.test'], date: 400 })
  add('t4', { folder: 2, thread: '<t4>', from: 'me@x.test', to: ['ann@x.test'], date: 500 })
})

describe('contactProfile', () => {
  it('counts mail both ways and how often you replied', () => {
    const p = contactProfile(1, 'ANN@x.test')!
    expect(p).toMatchObject({
      address: 'ann@x.test',
      name: 'Ann',
      received: 2,
      sent: 2,
      threads: 2,
      repliedThreads: 1,
      lastContact: 500
    })
    // Newest message per conversation with them.
    expect(p.recent.map((r) => r.id)).toEqual([ids.t4, ids.t2, ids.t1reply])
  })

  it('returns null without an address or an account', () => {
    expect(contactProfile(1, ' ')).toBeNull()
    expect(contactProfile(9, 'ann@x.test')).toBeNull()
  })
})

describe('threadCounterpart', () => {
  it('is the newest sender who is not you, else the first recipient', () => {
    expect(threadCounterpart(1, '<t1>')).toBe('ann@x.test')
    expect(threadCounterpart(1, '<t4>')).toBe('ann@x.test')
    expect(threadCounterpart(1, '<none>')).toBeNull()
  })
})
```

  In `src/core/store/tasks.test.ts`, add `searchTasks` to the `./tasks.js` import and:

```ts
  it('searches titles and descriptions of one account, open tasks first', () => {
    getDb().prepare("INSERT INTO accounts (id,email) VALUES (2,'c@d.test')").run()
    createTask({ account_id: ACC, title: 'Call the bank' })
    const done = createTask({ account_id: ACC, title: 'Statement', description: 'from the bank' })
    setTaskDone(done.id, true)
    createTask({ account_id: 2, title: 'bank elsewhere' })
    expect(searchTasks(ACC, 'bank').map((t) => t.title)).toEqual(['Call the bank', 'Statement'])
    expect(searchTasks(ACC, '  ')).toEqual([])
  })
```

  In `src/ui/appMode.test.ts`:
  - Add to `describe('appMode', ...)`:

```ts
  it('reads the search page as its own mode, under any open thread', () => {
    expect(appMode({ ...none, searchOpen: true })).toBe('search')
    expect(appMode({ ...none, searchOpen: true, openThread: true })).toBe('thread')
    expect(appMode({ ...none, searchOpen: true, overlayOpen: true })).toBe('modal')
  })
```

  - Change the `App wiring` expectation `'tasksOpen, openThread: !!openThread }'` to `'tasksOpen, openThread: !!openThread, searchOpen'`.

  In `src/ui/commands.test.ts`, add:

```ts
  it('opens the search page on /, leaves ⌘K to the palette, and toggles the contact pane on i', () => {
    expect(COMMANDS.find((c) => c.id === 'palette.open')!.keys).toEqual([{ kind: 'mod', key: 'k' }])
    const h = { 'search.open': () => {}, 'thread.contactPane': () => {} }
    expect(buildBindings('list', h).map((b) => [b.key, b.modes])).toEqual([
      ['/', ['list', 'thread']],
      ['i', ['thread']]
    ])
    // Tabs and history work on the search page; Esc there goes back.
    expect(buildChords('search', { 'history.back': () => {} }).map((c) => c.key)).toEqual(['['])
    expect(buildBindings('search', { escape: () => {} })[0].modes).toContain('search')
  })
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/core/store src/ui`. Expected: FAIL.

- [x] **Step 3: Core.**
  - Create `src/core/store/searchAll.ts`:

```ts
import type { MessageListRow } from './types.js'

/**
 * Search results from each account, as one list. One account keeps its
 * relevance order; several are merged newest first, since bm25 scores from
 * separate queries do not compare.
 */
export function mergeByDate(lists: MessageListRow[][], limit: number): MessageListRow[] {
  const nonEmpty = lists.filter((l) => l.length)
  if (nonEmpty.length <= 1) return (nonEmpty[0] ?? []).slice(0, limit)
  return nonEmpty
    .flat()
    .sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
    .slice(0, limit)
}
```

  - Create `src/core/store/contacts.ts`:

```ts
import { getDb } from './db.js'
import { LIST_COLS } from './repo.js'
import type { MessageListRow } from './types.js'

export interface ContactProfile {
  address: string
  name: string | null
  /** Messages from them. */
  received: number
  /** Messages from you with them in To or Cc. */
  sent: number
  /** Conversations they wrote in, and how many of those you also wrote in. */
  threads: number
  repliedThreads: number
  lastContact: number | null
  /** Newest message per conversation with them, newest first. */
  recent: MessageListRow[]
}

const M_COLS = LIST_COLS.split(', ')
  .map((c) => `m.${c}`)
  .join(', ')

const inRecipients = (col: string): string =>
  `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${col}) THEN ${col} ELSE '[]' END) v
            WHERE lower(json_extract(v.value, '$.address')) = @addr)`

function myAddress(accountId: number): string | null {
  const r = getDb().prepare('SELECT lower(email) AS e FROM accounts WHERE id = ?').get(accountId) as
    | { e: string }
    | undefined
  return r?.e ?? null
}

/** Everything the contact pane shows about one person, from synced mail of one account. */
export function contactProfile(accountId: number, address: string, limit = 8): ContactProfile | null {
  const addr = address.trim().toLowerCase()
  const me = myAddress(accountId)
  if (!addr || !me) return null
  const p = { acct: accountId, addr, me }
  const theirs = `m.account_id = @acct AND m.folder_id IS NOT NULL AND lower(COALESCE(m.from_addr, '')) = @addr`
  const mine = `m.account_id = @acct AND m.folder_id IS NOT NULL AND lower(COALESCE(m.from_addr, '')) = @me
                AND (${inRecipients('m.to_addrs')} OR ${inRecipients('m.cc_addrs')})`
  const db = getDb()
  const stats = db
    .prepare(
      `SELECT (SELECT count(*) FROM messages m WHERE ${theirs}) AS received,
              (SELECT count(*) FROM messages m WHERE ${mine}) AS sent,
              (SELECT max(m.date) FROM messages m WHERE (${theirs}) OR (${mine})) AS lastContact,
              (SELECT max(m.from_name) FROM messages m WHERE ${theirs} AND COALESCE(m.from_name, '') <> '') AS name`
    )
    .get(p) as { received: number; sent: number; lastContact: number | null; name: string | null }
  const replies = db
    .prepare(
      `WITH t AS (SELECT DISTINCT COALESCE(m.thread_id, '#' || m.id) AS k FROM messages m WHERE ${theirs})
       SELECT count(*) AS threads,
              COALESCE(SUM(EXISTS (
                SELECT 1 FROM messages r
                 WHERE r.account_id = @acct AND r.folder_id IS NOT NULL
                   AND COALESCE(r.thread_id, '#' || r.id) = t.k
                   AND lower(COALESCE(r.from_addr, '')) = @me)), 0) AS repliedThreads
         FROM t`
    )
    .get(p) as { threads: number; repliedThreads: number }
  const recent = db
    .prepare(
      `SELECT ${M_COLS} FROM messages m
        WHERE m.id IN (
          SELECT id FROM (
            SELECT m.id, ROW_NUMBER() OVER (PARTITION BY COALESCE(m.thread_id, '#' || m.id)
                                            ORDER BY m.date DESC, m.id DESC) AS rn
              FROM messages m WHERE (${theirs}) OR (${mine}))
           WHERE rn = 1)
        ORDER BY m.date DESC, m.id DESC
        LIMIT @limit`
    )
    .all({ ...p, limit }) as MessageListRow[]
  return { address: addr, ...stats, ...replies, recent }
}

/** Whom a thread is with: the newest sender who is not you, else the first recipient of the newest message. */
export function threadCounterpart(accountId: number, threadId: string): string | null {
  const me = myAddress(accountId)
  if (!me) return null
  const rows = getDb()
    .prepare(
      `SELECT from_addr, to_addrs FROM messages
        WHERE account_id = ? AND thread_id = ? AND folder_id IS NOT NULL
        ORDER BY date DESC, id DESC`
    )
    .all(accountId, threadId) as { from_addr: string | null; to_addrs: string | null }[]
  const other = rows.find((r) => r.from_addr && r.from_addr.toLowerCase() !== me)
  if (other?.from_addr) return other.from_addr.toLowerCase()
  for (const r of rows) {
    try {
      const to = JSON.parse(r.to_addrs ?? '[]') as { address?: string }[]
      const a = to.find((x) => x.address && x.address.toLowerCase() !== me)?.address
      if (a) return a.toLowerCase()
    } catch {
      // Not JSON: skip this row.
    }
  }
  return null
}
```

  - In `src/core/store/tasks.ts`, import `toFtsQuery` from `'./search.js'` and add:

```ts
/** The search page's Tasks scope: tasks_fts (migration v20) over title and description, open tasks first. */
export function searchTasks(accountId: number, query: string, limit = 50): Task[] {
  const fts = toFtsQuery(query)
  if (!fts) return []
  return getDb()
    .prepare(
      `SELECT t.* FROM tasks_fts JOIN tasks t ON t.id = tasks_fts.rowid
        WHERE tasks_fts MATCH ? AND t.account_id = ?
        ORDER BY t.done_at IS NOT NULL, bm25(tasks_fts), t.id
        LIMIT ?`
    )
    .all(fts, accountId, limit) as Task[]
}
```

- [x] **Step 4: IPC and preload.** In `electron/ipcPower.ts`, import `searchMessages` from `'../src/core/store/repo.js'`, `mergeByDate` from `'../src/core/store/searchAll.js'`, `searchTasks` from `'../src/core/store/tasks.js'`, `contactProfile, threadCounterpart` from `'../src/core/store/contacts.js'`, and `getBootState` from `'./state.js'`; add:

```ts
  // Every account, each query scoped to its own account_id.
  ipcMain.handle('search:all', (_e, query: string, limit = 100) =>
    mergeByDate(listAccounts().map((a) => searchMessages(a.accountId, query, limit)), limit)
  )

  ipcMain.handle('tasks:search', (_e, query: string, limit = 50) => {
    const s = getBootState()
    return s.ok ? searchTasks(s.accountId, query, limit) : []
  })

  ipcMain.handle('contact:forThread', (_e, threadId: string, accountId?: number) => {
    const s = getBootState()
    const acct = accountId ?? (s.ok ? s.accountId : null)
    if (acct == null) return null
    const address = threadCounterpart(acct, threadId)
    return address ? contactProfile(acct, address) : null
  })
```

  In `electron/preload.ts`, add `import type { ContactProfile } from '../src/core/store/contacts.js'` and:

```ts
  searchAll: (query: string, limit?: number): Promise<MessageListRow[]> => ipcRenderer.invoke('search:all', query, limit),
  searchTasks: (query: string, limit?: number): Promise<Task[]> => ipcRenderer.invoke('tasks:search', query, limit),
  contactForThread: (threadId: string, accountId?: number): Promise<ContactProfile | null> =>
    ipcRenderer.invoke('contact:forThread', threadId, accountId),
```

- [x] **Step 5: A `search` mode.**
  - `src/ui/hooks/useHotkeys.ts`: `export type Mode = 'list' | 'thread' | 'compose' | 'modal' | 'search'` and add `'search'` to `MODES`.
  - `src/ui/appMode.ts`: add `/** The search page is on screen (an open thread still wins). */ searchOpen?: boolean` to `Surface`, and make `baseMode` end with `if (s.openThread) return 'thread'` then `return s.searchOpen ? 'search' : 'list'`.
  - `src/ui/commands.ts`:
    - `NAV_MODES` becomes `['list', 'thread', 'search']` (update its comment).
    - `palette.open` keys become `[{ kind: 'mod', key: 'k' }]` (`/` moves to the search page).
    - `escape` keys become `[{ kind: 'key', key: 'Escape', modes: ['list', 'thread', 'search'] }]`.
    - Add `'search.open' | 'thread.contactPane'` to `CommandId`; after `palette.open`:

```ts
  { id: 'search.open', title: 'Search', group: 'General', palette: true, keys: [{ kind: 'key', key: '/', modes: LIST_THREAD }] },
```

      and after `thread.open`:

```ts
  { id: 'thread.contactPane', title: 'Show / hide contact pane', group: 'In a thread', palette: true, keys: [{ kind: 'key', key: 'i', modes: ['thread'] }] },
```

  - `src/ui/store.ts`: add `export const SEARCH_VIEW_ID = -3` (comment: `/** activeFolderId sentinel for the search page. */`), and state `searchQuery: string` (initial `''`) with `setSearchQuery: (q: string) => void` implemented as `set({ searchQuery })`.

- [x] **Step 6: Create `src/ui/views/SearchPage.tsx`.**

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Task } from '../../../electron/preload'
import type { MessageListRow } from '../../core/store/types'
import { formatDate, senderLabel } from '../format'

type Scope = 'emails' | 'contacts' | 'tasks'
const SCOPES: { id: Scope; label: string }[] = [
  { id: 'emails', label: 'Emails' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'tasks', label: 'Tasks' }
]

interface Props {
  query: string
  onQuery: (q: string) => void
  /** Any Gmail account: offer "Search the server". */
  hasGmail: boolean
  onOpenMessage: (row: MessageListRow) => void
  onOpenTasks: () => void
}

/**
 * The unified search page *(Scape)*. Keys here are local, like the palette:
 * Tab switches scope, ↑↓ move, ↵ opens. Esc reaches the registry's escape
 * (mode 'search'), which goes back.
 */
export function SearchPage({ query, onQuery, hasGmail, onOpenMessage, onOpenTasks }: Props) {
  const [text, setText] = useState(query)
  const [scope, setScope] = useState<Scope>('emails')
  const [emails, setEmails] = useState<MessageListRow[]>([])
  const [contacts, setContacts] = useState<{ address: string; name: string | null }[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [active, setActive] = useState(0)
  const [server, setServer] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  useEffect(() => inputRef.current?.focus(), [])
  // Back / forward can bring another query.
  useEffect(() => setText(query), [query])

  // Debounced like the palette; a sequence number drops answers to older queries.
  useEffect(() => {
    const t = setTimeout(() => {
      onQuery(text)
      const q = text.trim()
      const n = ++seq.current
      setActive(0)
      setServer(null)
      if (!q) {
        setEmails([])
        setContacts([])
        setTasks([])
        return
      }
      void window.api.searchAll(q, 100).then((r) => n === seq.current && setEmails(r))
      void window.api.searchContacts(q, 20).then((r) => n === seq.current && setContacts(r))
      void window.api.searchTasks(q, 50).then((r) => n === seq.current && setTasks(r))
    }, 150)
    return () => clearTimeout(t)
    // onQuery is a fresh closure each render; only the text should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  const runServer = async (): Promise<void> => {
    setServer('Searching the server…')
    const r = await window.api.searchServer(text.trim())
    if (!r.ok) return setServer(r.error)
    setServer(r.stored ? `Found ${r.stored} more on the server` : 'Nothing more on the server')
    if (r.stored) setEmails(await window.api.searchAll(text.trim(), 100))
  }

  const offerServer = hasGmail && scope === 'emails' && !!text.trim()
  const count = scope === 'emails' ? emails.length + (offerServer ? 1 : 0) : scope === 'contacts' ? contacts.length : tasks.length

  const openAt = (i: number): void => {
    if (scope === 'emails') {
      if (i === emails.length) void runServer()
      else if (emails[i]) onOpenMessage(emails[i])
    } else if (scope === 'contacts') {
      const c = contacts[i]
      if (!c) return
      setScope('emails')
      setText(`from:${c.address} OR to:${c.address}`)
    } else if (tasks[i]) onOpenTasks()
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const i = SCOPES.findIndex((s) => s.id === scope)
      setScope(SCOPES[(i + (e.shiftKey ? SCOPES.length - 1 : 1)) % SCOPES.length].id)
      setActive(0)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(count - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      openAt(active)
    }
  }

  return (
    <div className="search-page">
      <input
        ref={inputRef}
        className="search-input"
        placeholder="Search mail, people and tasks — from:, in:, label:, before:, OR, -word, &quot;phrase&quot;"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        spellCheck={false}
      />
      <div className="search-scopes" role="tablist">
        {SCOPES.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={scope === s.id}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setScope(s.id)
              setActive(0)
            }}
          >
            {s.label}
            <span className="search-scope-count">
              {s.id === 'emails' ? emails.length : s.id === 'contacts' ? contacts.length : tasks.length}
            </span>
          </button>
        ))}
      </div>
      <ul className="search-results">
        {scope === 'emails' &&
          emails.map((r, i) => (
            <li key={`${r.account_id}-${r.id}`} data-active={i === active} onClick={() => openAt(i)}>
              <span className="search-from">{senderLabel(r.from_name, r.from_addr)}</span>
              <span className="search-subject">{r.subject || '(no subject)'}</span>
              <span className="search-date">{formatDate(r.date)}</span>
            </li>
          ))}
        {offerServer && (
          <li data-active={active === emails.length} onClick={() => openAt(emails.length)} className="search-server">
            {server ?? 'Search the Gmail server for older mail'}
          </li>
        )}
        {scope === 'contacts' &&
          contacts.map((c, i) => (
            <li key={c.address} data-active={i === active} onClick={() => openAt(i)}>
              <span className="search-from">{c.name ?? c.address}</span>
              <span className="search-subject">{c.name ? c.address : ''}</span>
            </li>
          ))}
        {scope === 'tasks' &&
          tasks.map((t, i) => (
            <li key={t.id} data-active={i === active} data-done={!!t.done_at} onClick={() => openAt(i)}>
              <span className="search-subject">{t.title}</span>
              {t.due_at && <span className="search-date">{formatDate(t.due_at)}</span>}
            </li>
          ))}
      </ul>
    </div>
  )
}
```

- [x] **Step 7: Create `src/ui/views/ContactPane.tsx`.**

```tsx
import { useEffect, useState } from 'react'
import type { ContactProfile } from '../../core/store/contacts'
import { formatDate } from '../format'

interface Props {
  threadId: string
  accountId?: number
  onOpen: (threadId: string, messageId: number, accountId: number) => void
}

/** Who this thread is with, from the local DB only: no third-party enrichment. */
export function ContactPane({ threadId, accountId, onOpen }: Props) {
  const [p, setP] = useState<ContactProfile | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setP(undefined)
    void window.api.contactForThread(threadId, accountId).then((r) => {
      if (!cancelled) setP(r)
    })
    return () => {
      cancelled = true
    }
  }, [threadId, accountId])

  if (p === undefined) return <aside className="contact-pane" aria-busy="true" />
  if (p === null) return null
  return (
    <aside className="contact-pane" aria-label="Contact">
      <div className="contact-name">{p.name ?? p.address}</div>
      {p.name && <div className="contact-addr">{p.address}</div>}
      <dl className="contact-stats">
        <div>
          <dt>Emails</dt>
          <dd>
            {p.received} from · {p.sent} to
          </dd>
        </div>
        <div>
          <dt>You replied</dt>
          <dd>
            {p.repliedThreads} of {p.threads} conversations
          </dd>
        </div>
        {p.lastContact && (
          <div>
            <dt>Last</dt>
            <dd>{formatDate(p.lastContact)}</dd>
          </div>
        )}
      </dl>
      <h4>Recent</h4>
      <ul className="contact-recent">
        {p.recent.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => r.thread_id && onOpen(r.thread_id, r.id, r.account_id)}>
              <span>{r.subject || '(no subject)'}</span>
              <span className="contact-date">{formatDate(r.date)}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
```

  (`ContactProfile` is a type-only import from core, which the renderer may use.)

- [x] **Step 8: Wire App.** In `src/ui/App.tsx` (import `SEARCH_VIEW_ID` from `./store`, `SearchPage`, `ContactPane`):
  - Read `searchQuery` and `setSearchQuery` from `useStore()`.
  - `surface`: `const surface = { compose: !!compose, tasksOpen, openThread: !!openThread, searchOpen: activeFolderId === SEARCH_VIEW_ID }` (keep this exact text: `appMode.test.ts` matches it).
  - `fetchPage`: first line `if (folderId === SEARCH_VIEW_ID) return []` — the search page keeps its own results. In `loadRows`, the total for `SEARCH_VIEW_ID` is `rows.length`, like Reminders.
  - Workspace (Task 5 code): `viewNow` adds `query: s.activeFolderId === SEARCH_VIEW_ID ? s.searchQuery : undefined`; the recorder's "nothing changed" check also requires `s.searchQuery === prev.searchQuery`; `applyView` calls `setSearchQuery(v.query ?? '')` first when `v.folderId === SEARCH_VIEW_ID`; the boot restore's `special` list includes `SEARCH_VIEW_ID`; `viewLabel` returns `v.query ? \`Search: ${v.query}\` : 'Search'` for it.
  - Contact pane setting: `const [contactPane, setContactPane] = useState(true)`, set from `s.contact_pane !== '0'` in the mount settings effect.
  - Handlers:

```ts
        'search.open': () => {
          setSearchQuery('')
          void onFolder(SEARCH_VIEW_ID)
        },
        'thread.contactPane': () => {
          setContactPane((on) => {
            void window.api.setSettings({ contact_pane: on ? '0' : '1' })
            return !on
          })
        },
```

    and change `escape`:

```ts
        escape: ({ mode: m }) => {
          if (m === 'thread') closeThread()
          else if (m === 'search') {
            // Back to wherever the search was opened from; the Inbox if nowhere.
            const prev = workspaceRef.current && back(workspaceRef.current)
            if (prev) showWorkspace(prev)
            else gotoFolder('inbox')
          } else if (useStore.getState().checkedIds.length) clearChecked()
        },
```

    Add `setSearchQuery` to the `handlers` dependency list.
  - Render: wrap the thread, and add the search page before the list branch:

```tsx
        ) : openThread ? (
          <div className="thread-layout">
            <Thread … (as in Task 6) />
            {contactPane && (
              <ContactPane threadId={openThread.threadId} accountId={openThread.accountId} onOpen={openThreadAndRead} />
            )}
          </div>
        ) : activeFolderId === SEARCH_VIEW_ID ? (
          <SearchPage
            query={searchQuery}
            onQuery={setSearchQuery}
            hasGmail={accounts.some((a) => a.provider === 'gmail')}
            onOpenMessage={(r) => r.thread_id && openThreadAndRead(r.thread_id, r.id, r.account_id)}
            onOpenTasks={() => setTasksOpen(true)}
          />
        ) : (
```

  - `src/ui/views/Sidebar.tsx`: add `onSearch: () => void` to `Props` and, first in `sidebar-tasks`, a `folder-item` button with the `Search` icon from `lucide-react`, label "Search", `title="Search (/)"`, `aria-current={activeFolderId === SEARCH_VIEW_ID}` (import `SEARCH_VIEW_ID` from `'../store'`), calling `onSearch` after blurring like its siblings. In App pass `onSearch={() => { setSearchQuery(''); void onFolder(SEARCH_VIEW_ID) }}`.
  - Append to `src/ui/styles/app.css` (map colours to `tokens.css`):

```css
.search-page { display: flex; flex-direction: column; min-height: 0; flex: 1; padding: 12px 16px; gap: 8px; }
.search-input { font: inherit; font-size: 14px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: inherit; }
.search-scopes { display: flex; gap: 4px; }
.search-scopes button { border: 0; background: none; padding: 4px 8px; border-radius: 5px; color: var(--text-muted); font: inherit; font-size: 12.5px; }
.search-scopes button[aria-selected='true'] { background: var(--hover); color: var(--text); }
.search-scope-count { margin-left: 6px; opacity: 0.6; }
.search-results { list-style: none; margin: 0; padding: 0; overflow: auto; }
.search-results li { display: grid; grid-template-columns: 180px 1fr auto; gap: 12px; padding: 6px 8px; border-radius: 5px; font-size: 13px; cursor: default; }
.search-results li[data-active='true'] { background: var(--hover); }
.search-results li[data-done='true'] { opacity: 0.55; }
.search-from, .search-subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search-date { color: var(--text-muted); font-size: 12px; }
.search-server { grid-template-columns: 1fr !important; color: var(--text-muted); }
.thread-layout { display: flex; flex: 1; min-height: 0; }
.thread-layout > .thread { flex: 1; min-width: 0; }
.contact-pane { width: 260px; flex: none; border-left: 1px solid var(--border); padding: 16px; overflow: auto; font-size: 12.5px; }
.contact-name { font-weight: 600; font-size: 14px; }
.contact-addr, .contact-date, .contact-stats dt { color: var(--text-muted); }
.contact-stats { display: grid; gap: 6px; margin: 12px 0; }
.contact-stats div { display: flex; justify-content: space-between; gap: 8px; }
.contact-stats dd { margin: 0; }
.contact-recent { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.contact-recent button { display: flex; justify-content: space-between; gap: 8px; width: 100%; border: 0; background: none; text-align: left; padding: 4px 0; color: inherit; font: inherit; }
.contact-recent button span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 1000px) { .contact-pane { display: none; } }
```

    If `.thread` already sets its own width or flex in `app.css`, keep the pane working by giving `.thread-layout > .thread` precedence (it is more specific).

- [x] **Step 9: Run the tests, then the suite.** `pnpm exec vitest run src/core/store src/ui` passes. `pnpm typecheck && pnpm test` green (**74 files**).

- [ ] **Step 10: Check in the app.** `/` opens Search; typing `from:ann OR from:bob -newsletter` lists mail from both accounts; `Tab` to Contacts and `↵` on a person searches mail with them; Tasks finds a task by a word in its description; `Esc` returns to the list you came from. On Gmail, "Search the Gmail server" stores older hits. In a thread, the right pane shows the person's counts and recent conversations; `i` hides it and the choice survives a restart.

- [ ] **Step 11: Commit.**

```bash
git add src electron
git commit -m "[feat] unified search page with emails, contacts and tasks; contact pane"
```

---

### Task 12: Full offline history, docs and the end-to-end check

A background worker walks every synced folder backwards, headers only, until it reaches uid 1, so search and the contact pane see the whole mailbox (Superhuman keeps about 30 days). Then the docs.

**Files:**
- Create: `src/core/sync/historyPlan.ts`, `src/core/sync/historyPlan.test.ts`, `electron/historyWorker.ts`
- Modify: `src/core/store/repo.ts`, `src/core/store/types.ts`, `src/core/store/folderRepo.test.ts`, `electron/ipc.ts`, `electron/main.ts`, `src/ui/views/TriageSettings.tsx`, `README.md`, `CLAUDE.md`

- [x] **Step 1: Write the failing tests.** Create `src/core/sync/historyPlan.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { nextHistoryFolder } from './historyPlan.js'

const f = (id: number, path: string, role: string | null, history_complete = 0) =>
  ({ id, path, role, history_complete }) as Parameters<typeof nextHistoryFolder>[0][number]

describe('nextHistoryFolder', () => {
  it('walks Inbox, Sent, Done, other folders by path, then Trash / Junk / Drafts', () => {
    const all = [
      f(1, 'Trash', 'trash'),
      f(2, 'Zeta', null),
      f(3, 'Sent', 'sent'),
      f(4, 'Alpha', null),
      f(5, 'Archive', 'archive'),
      f(6, 'INBOX', 'inbox')
    ]
    const order: number[] = []
    let left = all
    for (let next = nextHistoryFolder(left); next; next = nextHistoryFolder(left)) {
      order.push(next.id)
      left = left.map((x) => (x.id === next!.id ? { ...x, history_complete: 1 } : x))
    }
    expect(order).toEqual([6, 3, 5, 4, 2, 1])
  })

  it('is null when every folder is complete', () => {
    expect(nextHistoryFolder([f(1, 'INBOX', 'inbox', 1)])).toBeNull()
    expect(nextHistoryFolder([])).toBeNull()
  })
})
```

  Append to `src/core/store/folderRepo.test.ts` (its `beforeEach` creates accounts 1 and 2; its `folder(account, path)` helper returns the `Folder`), and add `resetFolder, setHistoryComplete` to its `./repo.js` import:

```ts
describe('history_complete', () => {
  it('is set by setHistoryComplete and cleared when the folder is renumbered', () => {
    const { id } = folder(1, 'INBOX')
    expect(getFolder(id)?.history_complete).toBe(0)
    setHistoryComplete(id)
    expect(getFolder(id)?.history_complete).toBe(1)
    resetFolder(id, 999)
    expect(getFolder(id)?.history_complete).toBe(0)
  })
})
```

- [x] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run src/core/sync/historyPlan.test.ts src/core/store/folderRepo.test.ts`. Expected: FAIL.

- [x] **Step 3: Repo and types.**
  - `src/core/store/types.ts`: add to `Folder` `/** 1 once full-history backfill has reached uid 1 (migration v20). */ history_complete?: number`.
  - `src/core/store/repo.ts`: in `resetFolder`, change the UPDATE to `'UPDATE folders SET uidvalidity = ?, last_uid = 0, history_complete = 0 WHERE id = ?'`; and add:

```ts
/** Full-history backfill reached the oldest message of this folder. */
export function setHistoryComplete(folderId: number): void {
  getDb().prepare('UPDATE folders SET history_complete = 1 WHERE id = ?').run(folderId)
}
```

- [x] **Step 4: Create `src/core/sync/historyPlan.ts`.**

```ts
import type { Folder } from '../store/types.js'

type HistoryFolder = Pick<Folder, 'id' | 'path' | 'role'> & { history_complete?: number }

const FIRST = ['inbox', 'sent', 'archive', 'all']
const LAST = ['trash', 'junk', 'drafts']

function rank(f: HistoryFolder): number {
  const i = f.role ? FIRST.indexOf(f.role) : -1
  if (i >= 0) return i
  return f.role && LAST.includes(f.role) ? 99 : 10
}

/** The folder full-history backfill works on next: Inbox, Sent, Done, the rest by path, then Trash / Junk / Drafts. */
export function nextHistoryFolder<T extends HistoryFolder>(folders: T[]): T | null {
  const open = folders.filter((f) => !f.history_complete)
  open.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
  return open[0] ?? null
}
```

- [x] **Step 5: Share the backfill guard.** In `electron/ipc.ts`:
  - `export` the existing `heldSourceUids` function.
  - Add under it:

```ts
/** One backfill per account at a time: Load older and the history worker share it. Null when one is running. */
export async function runBackfillExclusive<T>(accountId: number, fn: () => Promise<T>): Promise<T | null> {
  if (backfilling.has(accountId)) return null
  backfilling.add(accountId)
  try {
    return await fn()
  } finally {
    backfilling.delete(accountId)
  }
}
```

  - Rewrite the body of `messages:loadOlder` after the folder lookup to use it:

```ts
    try {
      const r = await runBackfillExclusive(s.accountId, () =>
        backfillFolder(s.accountId, s.config, folder, limit, () => heldSourceUids(s.accountId, folder.path))
      )
      return r ? { ok: true as const, ...r } : { ok: false as const, error: 'already loading' }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
```

- [x] **Step 6: Create `electron/historyWorker.ts`** and start it.

```ts
import { getSettings, listFolders, oldestSyncedUid, setHistoryComplete } from '../src/core/store/repo.js'
import { backfillFolder } from '../src/core/sync/syncEngine.js'
import { shouldSyncFolder } from '../src/core/sync/folderFilter.js'
import { nextHistoryFolder } from '../src/core/sync/historyPlan.js'
import { heldSourceUids, runBackfillExclusive } from './ipc.js'
import { listAccounts } from './state.js'

const PAGE = 500
let timer: ReturnType<typeof setInterval> | null = null

/**
 * Full offline history: one page of older headers per account per tick, until
 * each synced folder reaches uid 1. Bodies stay on demand. Off when
 * settings.full_history is '0'. Runs only while the app does, like every
 * other worker.
 */
export function startHistoryWorker(intervalMs = 60_000): void {
  if (timer) return
  let running = false
  const tick = async (): Promise<void> => {
    if (running || getSettings().full_history === '0') return
    running = true
    try {
      for (const a of listAccounts()) {
        // A folder with nothing local yet belongs to the forward sync, not to backfill.
        const folders = listFolders(a.accountId).filter(
          (f) => shouldSyncFolder(a.config.provider, f) && oldestSyncedUid(f.id) !== null
        )
        const next = nextHistoryFolder(folders)
        if (!next) continue
        const r = await runBackfillExclusive(a.accountId, () =>
          backfillFolder(a.accountId, a.config, next, PAGE, () => heldSourceUids(a.accountId, next.path))
        )
        if (r && !r.more) setHistoryComplete(next.id)
      }
    } catch (e) {
      console.error('[history] backfill failed:', e)
    } finally {
      running = false
    }
  }
  timer = setInterval(() => void tick(), intervalMs)
}
```

  In `electron/main.ts`, import `startHistoryWorker` from `'./historyWorker.js'` and call it after `startReminderWorker()`.

  In `src/ui/views/TriageSettings.tsx`, add `const [fullHistory, setFullHistory] = useState(true)`, set it from `s.full_history !== '0'` in the mount effect, and append as the last section:

```tsx
      <section className="settings-section">
        <h3>Offline history</h3>
        <label className="picker-check">
          <input
            type="checkbox"
            checked={fullHistory}
            onChange={(e) => {
              setFullHistory(e.target.checked)
              void window.api.setSettings({ full_history: e.target.checked ? '1' : '0' })
            }}
          />
          Download the whole mailbox in the background (headers only)
        </label>
      </section>
```

- [x] **Step 7: Run the tests, then the suite.** `pnpm exec vitest run src/core` passes. `pnpm typecheck && pnpm test` green (**75 files**).

- [x] **Step 8: Update `CLAUDE.md`.**
  - **Roadmap**: add `| Phase 3 | Done | Tabs + history, unified inbox, ⌃1–9, remappable keys, thread keys, snippets, send later / Send + Done / intro, cancel-on-reply, search operators + search page, contact pane, full history |`; remove "Full history sync" from the Later row.
  - **Keyboard**, add:

```markdown
- `KeySpec` kinds: `key`, `seq`, `mod` (⌘, Ctrl off macOS) and `ctrl` (the physical Control key: `⌃1–9` accounts, `⌃Tab` tabs). A `ctrl` chord is matched before a `mod` chord on the same key.
- Builders take the command list (`applyKeymap(COMMANDS, settings.keymap)`); never read `COMMANDS` directly in App. Numbered families (`account.1–9`, `tab.1–9`) set `sheet` so the shortcut sheet shows one row.
- Modes include `search` (the search page). Tab and history chords use `NAV_MODES` (list, thread, search) and stay off in compose.
- `⌘W` is close-tab: `electron/menu.ts` moves Close Window to `⇧⌘W`. Check `menu.ts` before taking any ⌘ chord the default menu might own.
- Thread keys drive `ThreadHandle` (`src/ui/views/Thread.tsx`); App holds no thread reading state.
```

  - **Local-first rules**, add:

```markdown
8. Navigation is recorded, not pushed: a store subscription in App turns every change of folder / split / chip / thread / search query into a workspace history step (`src/ui/workspace.ts`). Back, forward and tab switches call `applyView`, which must change the store before its first await.
9. The unified inbox (`UNIFIED_VIEW_ID`) reads `list_rows` with `(lr.account_id = ? AND lr.folder_id = ?) OR …` (`src/core/store/unified.ts`). Every list row carries `account_id`; thread reads, read/unread and compose pass the row's account to main.
```

  - **Schema**, add:

```markdown
- `snippets` (global, plain text with `{variables}`), `tasks_fts` (trigger-kept), `outbox.cancel_on_reply` (the pipeline's `cancelAndNotify` cancels a pending scheduled reply when its thread gets a reply), `folders.history_complete` (full-history worker).
- Settings keys added in Phase 3: `keymap`, `workspace`, `cancel_on_reply_default`, `contact_pane`, `full_history`.
```

  - **Code map**, add `electron/ipcPower.ts — Phase 3 handlers`, `electron/menu.ts — app menu`, `electron/historyWorker.ts — full history`.

- [x] **Step 9: Update `README.md`.** In Features, add one line each: workspace tabs with back / forward (`⌘T`, `⌘1–9`, `⌘[`), unified inbox across accounts and `⌃1–9` to switch, remappable shortcuts, thread keys (`o`, `n`/`p`, `Space`, `Tab` through links, `⌘O`, `↵` reply all) with a position counter, snippets (`;name ⇥`, `⌘;`), send later, Send + Done, Instant Intro, cancel a scheduled reply when someone replies first, search with `OR` / `-word` / `"phrase"` / `in:` / `label:` / `before:` / `after:` on one search page (`/`), a contact pane, and the full mailbox offline. In the keyboard table, add the rows from this plan's key map and change `/` from the palette to Search.

- [x] **Step 10: Full check.** `pnpm typecheck && pnpm test && pnpm build`. All green.

- [ ] **Step 11: Manual end-to-end** in `pnpm dev`, with the Exmail account and a Gmail account both connected:
  1. **Sent copy:** send two replies within five seconds, the second with `⌘⇧H` "in 1 hour": both appear in Sent within ~5 s, and the second shows in `g h` at once (the Phase 2 QA case).
  2. **Tabs:** `⌘T`, `⌘1–9`, `⌃Tab`, `⌘[` / `⌘]`, `⌘W` (window stays), `⇧⌘W` (window closes); tabs come back after a restart.
  3. **Unified inbox and accounts:** `g a` lists both Inboxes with account labels; `e` and `u` act on the right account in each webmail; a reply from a Gmail row leaves from the Gmail address; `⌃1` / `⌃2` switch accounts.
  4. **Remap:** change Done to `y` in Settings → Shortcuts; `y` archives and the sheet (`⌘.`) shows `y`; mapping it to `s` is refused with the clash named.
  5. **Thread:** `n`/`p`, `o`/`O`, `Space`, `Tab` + `⌘O`, `↵`, `j`/`k` with the counter.
  6. **Compose:** snippet inline and from `⌘;`, `⌘⇧I`, `⌘⇧O/C/B/S`, `⌘⇧L` "in 5 minutes" with "Cancel if someone replies first", then reply to that thread from webmail: the send is cancelled and the banner says so. `⌘⇧↵` + `z` restores both.
  7. **Search:** the operators on the search page and in ⌘K; Gmail server search stores an old message.
  8. **History:** with Settings → Offline history on, the oldest Inbox page keeps growing in the pager over a few minutes; turning it off stops it.
  9. **Perf:** the dev console shows no `[perf]` warning for `tab.next`, `history.back`, `thread.nextMsg`, `go.unified`.

- [ ] **Step 12: Commit.**

```bash
git add src electron CLAUDE.md README.md
git commit -m "[feat] full offline history; [docs] phase 3"
```

---

## Self-review notes

- **Spec coverage (Phase 3):**
  - Carry-over from Phase 2 QA, the late Sent copy of a quick second send → Task 1 (with tests for the race and the per-account queue).
  - Workspace tabs *(Scape)*: views per tab (folder, split, search or thread), `⌘T` / `⌘W` / `⌘1–9` / `⌃Tab` / `⌃⇧Tab`, per-tab back / forward on `⌘[` / `⌘]`, renderer state persisted (one window, `settings.workspace`), every entry a registry command → Task 5 (registry mechanics in Task 3, `⌘W` freed by the menu in Task 3).
  - Thread: `O` / `⇧O`, `N` / `P`, `Space` / `⇧Space`, `⌘O` for links and attachments, `Tab` through links, `↵` reply all *(Scape)* with `r` kept, position counter "15 / 201" with up/down buttons *(Scape)* → Task 6.
  - Compose: snippets with variables via `;` inline and the `⌘;` picker from a local `snippets` table → Tasks 2 and 8; Instant Intro `⌘⇧I`, Send + Done `⌘⇧↵`, send later `⌘⇧L`, field jumps `⌘⇧O/C/B/S` → Task 7; cancel a scheduled send when someone replies *(Scape)*, per-send toggle with a Settings default, pipeline match on References / In-Reply-To, notice, local only → Task 9 ("cancel-on-reply matches only the scheduled send's own thread" test from the spec's Verification list).
  - Search: `OR`, `-term`, `"phrase"`, `in:`, `label:`, `before:` / `after:`, Gmail `X-GM-RAW` server fallback → Task 10; unified search *(Scape)* with Emails / Contacts / Tasks scopes, contacts from `searchContacts`, an FTS index over `tasks` → Tasks 2 and 11.
  - Contact pane: recent mail with the person and how often you replied, local DB only → Task 11.
  - Where we beat Superhuman: unified inbox (built on Phase 0.2's owner-scoped IPC; every query scoped by `account_id`) → Task 4; `Ctrl+1–9` → Task 3; remappable shortcuts via the registry → Task 3; full offline history → Task 12.
- **Choices made where the spec was silent:**
  - `/` moves from the palette's second key to the search page; `⌘K` stays the palette. `i` toggles the contact pane; `j` / `k` in a thread step conversations (free in thread mode, Superhuman's habit).
  - Tabs are capped at 9 and `⌘9` is the last tab; a new tab opens on the current list. History is recorded from store changes (120 ms coalescing), so no call site pushes history and auto-advance is one step.
  - Send later reuses the natural-language `RemindPicker`, which replaces the old fixed "Later" menu; its checkbox becomes "Cancel if someone replies first" for replies.
  - Send + Done's undo takes back both the send and the move, because there is one undo slot.
  - Snippets are global plain text; unknown or empty variables stay visible as typed.
  - Unified search searches mail of every account and merges by date; Contacts and Tasks stay on the active account.
  - `after:` means on or after that day (local midnight); a malformed date is searched as text.
  - Full history is on by default, headers only, one 500-message page per account per minute.
- **Known gaps:**
  - Off macOS (⌘ is Ctrl), `⌃1–9` wins, so `⌘1–9` tab jumps are not reachable there; `⌃Tab` and clicks still switch tabs.
  - Tabs reload their list on switch, so the cursor returns to the top (thread → list in one tab keeps it).
  - A tab whose folder belongs to another account is dropped on restore after an account switch.
  - Inline `;snippet` expansion needs the caret in a text node (it is after typing); `⌘;` works anywhere.
  - The contact pane and unified search read only what is synced; with full history off, older mail is missing until "Load older" or Gmail server search fetches it.
  - Gmail server search covers Inbox/Sent/Drafts/Trash/Spam only; archived mail (All Mail) is not reachable, because All Mail is not synced and its hits would need a local home. Searching All Mail is a design decision for a later phase.
  - Cancel-on-reply needs the reply to sync before the send time; with the app closed nothing happens (spec decision).
  - Electron's handling of `⌘W` with a custom menu, and of `⌃Tab` reaching the page, is checked manually (Task 5 Step 8, Task 12 Step 11); there is no automated Electron test.
- **Names used across tasks:**
  - Send: `waitForSentCopy`, `hasSentCopy`, `serialPerKey`, `SENT_POLL_ATTEMPTS`, `SENT_POLL_INTERVAL_MS` (`sentRefresh.ts`); `flushOutboxRow` → `{ ok: true, messageId }`; `onSent(accountId, messageId)`; `refreshSentFolder(accountId, config, messageId)`; `CancelledSend`, `outboxThreadIds`, `cancelScheduledOnReply`, `onScheduledCancelled`, `cancelAndNotify` (`cancelOnReply.ts`); `OutboxRow.cancel_on_reply`.
  - Store: `LIST_COLS` with `account_id`; `LIST_ROW_COLS` (`listRows.ts`); `InboxScope`, `inboxScopes`, `listUnified`, `countUnified`, `unifiedUnread`, `unifiedSplitCounts` (`unified.ts`); `Snippet`, `listSnippets`, `saveSnippet`, `deleteSnippet`; `parseQuery` → `{ terms, phrases, predicates }`, `ftsQueryOf`, `toFtsPhrase`, `parseDay`; `mergeByDate`; `ContactProfile`, `contactProfile`, `threadCounterpart`; `searchTasks`; `setHistoryComplete`; `Folder.history_complete`.
  - Sync: `gmailRawQuery`, `missingUids`, `gmailSearchUids` (`serverSearch.ts`); `fetchUids` (`syncEngine.ts`); `nextHistoryFolder` (`historyPlan.ts`); `runBackfillExclusive`, `heldSourceUids` (`ipc.ts`); `startHistoryWorker`; `installAppMenu`; `registerPowerIpc`.
  - IPC channels: `unified:list|count|splitCounts|unread`, `sync:runAll`, `snippets:list|save|delete`, `search:server`, `search:all`, `tasks:search`, `contact:forThread`, event `send:cancelledOnReply`; `thread:get|markRead|markUnread` take a trailing `accountId`; `DraftPayload.accountId`, `QueueSendPayload.cancelOnReply`.
  - UI: `MODES`, `eventKey` (`Space`, `Shift+Space`), `Chord.ctrl`, `matchChord`; `KeySpec` kind `ctrl`, `Digit`, `DIGITS`, `Command.sheet`, `NAV_MODES`, builders' `commands` parameter; `RemapSpec`, `Keymap`, `isRemappable`, `parseKeymap`, `applyKeymap`, `keymapConflicts`, `specFromEvent`; `View`, `Tab`, `Workspace`, `MAX_TABS`, `MAX_HISTORY`, `sameView`, `initWorkspace`, `currentView`, `navigate`, `replaceCurrent`, `record`, `back`, `forward`, `canGoBack`, `canGoForward`, `openTab`, `closeTab`, `selectTab`, `cycleTab`, `serializeWorkspace`, `restoreWorkspace`; `threadsByAccount`; `stepIndex`, `toggleAllExpanded`, `cycleIndex`, `positionLabel`; `ThreadHandle`; `instantIntro`; `snippetVars`, `expandSnippet`, `snippetHtml`, `shortcutBeforeCaret`; `captureCaret`; `UNIFIED_VIEW_ID` (-2), `SEARCH_VIEW_ID` (-3), `searchQuery` / `setSearchQuery`, `ComposeState.accountId` / `sourceMessageId`, `openThread.accountId`; App: `applyView`, `showWorkspace`, `stepWorkspace`, `viewNow`, `stepConversation`, `switchToAccountAt`.
  - Settings keys: `keymap`, `workspace`, `cancel_on_reply_default`, `contact_pane`, `full_history`.
