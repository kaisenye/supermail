# Phase 0 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Exmail-shaped assumptions that block Gmail/Outlook and Superhuman-style triage. This plan covers:
- folder roles in place of hardcoded paths
- message handlers that act on the account owning the message
- a persisted, generalized move queue
- one command registry behind hotkeys, ⌘K and the shortcut sheet
- a 100ms speed budget, with neighbor-body prefetch

**Architecture:**
- A pure `assignRoles()` maps IMAP SPECIAL-USE attributes, then folder names, to one role per account. Roles are stored in `folders.role`, and every caller looks folders up with `folderByRole()`.
- IPC handlers that take message ids resolve the owning account through `groupByAccount()`.
- `MoveWriter` persists each job in a `move_jobs` table and replays them on boot and after every sync.
- The UI declares every action once in `src/ui/commands.ts`. Builders turn that list into `useHotkeys` bindings, ⌘ chords, `g`-sequences, palette actions and the shortcut sheet.

**Tech stack:**
- Electron 43, React 19, TypeScript (strict, `noUnusedLocals`), Zustand
- better-sqlite3 (WAL, FTS5), imapflow, vitest

**Spec:** `docs/superpowers/specs/2026-10-18-superhuman-parity-design.md` (Phase 0)

**Conventions in this repo:**
- Core imports use `.js` suffixes (`'./db.js'`). UI imports have no suffix (`'./store'`), but UI tests import with `.js`.
- Migrations are append-only (`src/core/store/migrate.ts`). Never edit a shipped entry.
- DB tests call `closeDb(); initDb(<tmp file>)` in `beforeEach` (see `src/core/store/tasks.test.ts`).
- Commit messages use `[feat]` / `[fix]` / `[refactor]` / `[test]` / `[docs]` and a lower-case summary. Skip the commit steps if the user has said to leave changes uncommitted.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/core/store/folderRoles.ts` | create | `FolderRole`, `MoveTarget` types; pure `assignRoles()` |
| `src/core/store/folderRoles.test.ts` | create | role assignment rules |
| `src/core/store/migrate.ts` | modify | v14 `folders.role` (+backfill, unique index), v15 `move_jobs` |
| `src/core/store/types.ts` | modify | `Folder.role` |
| `src/core/store/repo.ts` | modify | `setFolderRoles`, `folderByRole`, `getFolder`, `accountOfMessage`, `groupByAccount` |
| `src/core/store/folderRepo.test.ts` | create | role persistence + lookup |
| `src/core/store/ownership.test.ts` | create | `groupByAccount` |
| `src/core/store/moveJobs.ts` | create | persisted move queue rows |
| `src/core/sync/syncEngine.ts`, `bodySync.ts` | modify | write roles on sync; INBOX-first by role |
| `src/core/sync/moveWriter.ts` | rewrite | persisted queue, injectable mover, `resume()`, `whenIdle()` |
| `src/core/sync/moveWriter.test.ts` | create | persistence / retry / replay |
| `src/core/send/flush.ts`, `electron/workers.ts` | modify | Sent folder by role |
| `electron/ipc.ts` | modify | roles for trash/drafts; owner-resolved handlers; `messages:move(ids, target)`; `messages:prefetchBodies`; `resumePendingMoves` |
| `electron/main.ts` | modify | resume pending moves at boot |
| `electron/preload.ts` | modify | `moveMessages(ids, target)`, `prefetchBodies(ids)` |
| `src/ui/format.ts`, `src/ui/folderIcons.tsx`, `src/ui/views/Sidebar.tsx` | modify | label/icon/order by role |
| `src/ui/folderLabel.test.ts` | create | role labels |
| `src/ui/commands.ts` | create | command registry + builders |
| `src/ui/commands.test.ts` | create | no key conflicts, sheet/palette output |
| `src/ui/hooks/useKeySequences.ts` | create | `g` then `x` listener (moved out of App) |
| `src/ui/perf.ts`, `src/ui/perf.test.ts` | create | `timed()` speed budget |
| `src/ui/views/ShortcutHelp.tsx` | modify | render from registry |
| `src/ui/App.tsx` | modify | roles, move target, registry wiring, prefetch |
| `CLAUDE.md` | modify | document roles, registry, move_jobs |

---

### Task 0: Baseline

**Files:** none

- [ ] **Step 1: Make pnpm 10 available.**
  - Run: `pnpm -v`
  - Expected: `10.x`.
  - If it fails, corepack is trying to fetch pnpm 12. Run `npm i -g pnpm@10` (CI pins 10) and retry.

- [ ] **Step 2: Install the way CI does.**
  - Run: `pnpm install --frozen-lockfile --ignore-scripts`
  - Expected: completes without errors.

- [ ] **Step 3: Record the baseline.**
  - Run: `pnpm typecheck && pnpm test`
  - Expected: typecheck clean and all existing test files pass.
  - If the DB tests (`tasks.test.ts`, `threadedList.test.ts`) fail with a missing or mismatched `better_sqlite3.node`, run `pnpm rebuild better-sqlite3` and re-run.
  - Write down the pass count, so later regressions are obvious.

---

### Task 1: Pure folder-role assignment

**Files:**
- Create: `src/core/store/folderRoles.ts`
- Test: `src/core/store/folderRoles.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// src/core/store/folderRoles.test.ts
import { describe, expect, it } from 'vitest'
import { assignRoles } from './folderRoles.js'

const box = (path: string, specialUse: string | null = null) => ({ path, specialUse })

describe('assignRoles', () => {
  it('maps Exmail folders, which advertise no SPECIAL-USE', () => {
    const roles = assignRoles([
      box('INBOX'),
      box('Sent Messages'),
      box('Drafts'),
      box('Deleted Messages'),
      box('Junk'),
      box('客户')
    ])
    expect(Object.fromEntries(roles)).toEqual({
      INBOX: 'inbox',
      'Sent Messages': 'sent',
      Drafts: 'drafts',
      'Deleted Messages': 'trash',
      Junk: 'junk'
    })
  })

  it('prefers SPECIAL-USE over a matching name', () => {
    const roles = assignRoles([box('Sent'), box('[Gmail]/Sent Mail', '\\Sent')])
    expect(roles.get('[Gmail]/Sent Mail')).toBe('sent')
    expect(roles.has('Sent')).toBe(false)
  })

  it('maps Gmail system folders', () => {
    const roles = assignRoles([
      box('INBOX', '\\Inbox'),
      box('[Gmail]/All Mail', '\\All'),
      box('[Gmail]/Spam', '\\Junk'),
      box('[Gmail]/Trash', '\\Trash'),
      box('[Gmail]/Drafts', '\\Drafts')
    ])
    expect(roles.get('[Gmail]/All Mail')).toBe('all')
    expect(roles.get('[Gmail]/Spam')).toBe('junk')
    expect(roles.get('[Gmail]/Trash')).toBe('trash')
    expect(roles.get('[Gmail]/Drafts')).toBe('drafts')
  })

  it('maps Outlook names', () => {
    const roles = assignRoles([
      box('Sent Items'),
      box('Deleted Items'),
      box('Junk Email'),
      box('Archive')
    ])
    expect(roles.get('Sent Items')).toBe('sent')
    expect(roles.get('Deleted Items')).toBe('trash')
    expect(roles.get('Junk Email')).toBe('junk')
    expect(roles.get('Archive')).toBe('archive')
  })

  it('reads children of INBOX on dot-delimited servers', () => {
    expect(assignRoles([box('INBOX'), box('INBOX.Sent')]).get('INBOX.Sent')).toBe('sent')
  })

  it('never gives a nested user folder a role from its name', () => {
    expect(assignRoles([box('Projects/Archive')]).has('Projects/Archive')).toBe(false)
  })

  it('keeps the old preference order when two names match', () => {
    // Exmail order: "Deleted Messages" beat "Trash" in the old TRASH_PATHS.
    const roles = assignRoles([box('Trash'), box('Deleted Messages')])
    expect(roles.get('Deleted Messages')).toBe('trash')
    expect(roles.has('Trash')).toBe(false)
  })

  it('gives each role to one folder only', () => {
    const roles = assignRoles([box('A', '\\Sent'), box('B', '\\Sent')])
    expect([...roles.values()].filter((r) => r === 'sent')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `pnpm exec vitest run src/core/store/folderRoles.test.ts`
  - Expected: FAIL, "Failed to resolve import ./folderRoles.js".

- [ ] **Step 3: Implement.**

```ts
// src/core/store/folderRoles.ts

/** What a folder is for, independent of what the server calls it. */
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all'

/** Where a move goes: a role (resolved per account) or one specific folder. */
export type MoveTarget = { role: FolderRole } | { folderId: number }

export interface RoleCandidate {
  path: string
  /** RFC 6154 attribute as imapflow reports it, e.g. '\\Sent'. */
  specialUse: string | null
}

const SPECIAL_USE: Record<string, FolderRole> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all'
}

/**
 * Lower-cased names for servers without SPECIAL-USE (Exmail). Earlier entries
 * win, which keeps the order of the old hardcoded SENT_PATHS / TRASH_PATHS.
 */
const NAMES: Record<FolderRole, string[]> = {
  inbox: ['inbox'],
  sent: ['sent messages', 'sent', 'sent items', 'sent mail'],
  drafts: ['drafts', 'draft'],
  trash: ['deleted messages', 'trash', 'deleted items', 'deleted', 'bin'],
  junk: ['junk', 'spam', 'junk email', 'junk e-mail', 'bulk mail'],
  archive: ['archive', 'archives'],
  all: ['all mail']
}

/**
 * Leaf name, lower-cased, for top-level folders and children of INBOX only.
 * A nested user folder such as Projects/Archive must never become the
 * account's archive just because of its name.
 */
function topLevelLeaf(path: string): string | null {
  const parts = path.split(/[/.]/)
  if (parts.length === 1) return parts[0].toLowerCase()
  if (parts.length === 2 && parts[0].toUpperCase() === 'INBOX') return parts[1].toLowerCase()
  return null
}

/**
 * One folder per role for an account. INBOX is fixed by RFC 3501; then
 * SPECIAL-USE; then names. Returns path -> role for the folders that got one.
 */
export function assignRoles(boxes: RoleCandidate[]): Map<string, FolderRole> {
  const out = new Map<string, FolderRole>()
  const taken = new Set<FolderRole>()
  const give = (path: string, role: FolderRole): void => {
    out.set(path, role)
    taken.add(role)
  }

  const inbox = boxes.find((b) => b.path.toUpperCase() === 'INBOX')
  if (inbox) give(inbox.path, 'inbox')

  for (const b of boxes) {
    const role = b.specialUse ? SPECIAL_USE[b.specialUse] : undefined
    if (!role || taken.has(role) || out.has(b.path)) continue
    give(b.path, role)
  }

  for (const role of Object.keys(NAMES) as FolderRole[]) {
    if (taken.has(role)) continue
    let best: { path: string; rank: number } | null = null
    for (const b of boxes) {
      if (out.has(b.path)) continue
      const leaf = topLevelLeaf(b.path)
      if (leaf === null) continue
      const rank = NAMES[role].indexOf(leaf)
      if (rank !== -1 && (!best || rank < best.rank)) best = { path: b.path, rank }
    }
    if (best) give(best.path, role)
  }

  return out
}
```

- [ ] **Step 4: Run it and confirm it passes.**
  - Run: `pnpm exec vitest run src/core/store/folderRoles.test.ts`
  - Expected: PASS (8 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/core/store/folderRoles.ts src/core/store/folderRoles.test.ts
git commit -m "[feat] resolve folder roles from SPECIAL-USE and names"
```

---

### Task 2: Store folder roles (schema v14 + repo)

**Files:**
- Modify: `src/core/store/migrate.ts` (append to `migrations`)
- Modify: `src/core/store/types.ts` (`Folder`)
- Modify: `src/core/store/repo.ts` (folders section)
- Test: `src/core/store/folderRepo.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// src/core/store/folderRepo.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import { folderByRole, getFolder, setFolderRoles, upsertFolder } from './repo.js'

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'folders-')), 't.db'))
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (1,'a@b.test'),(2,'c@d.test')").run()
})

const folder = (account_id: number, path: string) =>
  upsertFolder({ account_id, name: path, path, uidvalidity: null })

describe('folder roles', () => {
  it('looks a folder up by role, per account', () => {
    folder(1, 'Sent Messages')
    folder(2, '[Gmail]/Sent Mail')
    setFolderRoles(1, new Map([['Sent Messages', 'sent']]))
    setFolderRoles(2, new Map([['[Gmail]/Sent Mail', 'sent']]))
    expect(folderByRole(1, 'sent')?.path).toBe('Sent Messages')
    expect(folderByRole(2, 'sent')?.path).toBe('[Gmail]/Sent Mail')
    expect(folderByRole(1, 'archive')).toBeUndefined()
  })

  it('moves a role between folders without tripping the unique index', () => {
    const a = folder(1, 'Sent')
    folder(1, 'Sent Messages')
    setFolderRoles(1, new Map([['Sent', 'sent']]))
    setFolderRoles(1, new Map([['Sent Messages', 'sent']]))
    expect(folderByRole(1, 'sent')?.path).toBe('Sent Messages')
    expect(getFolder(a.id)?.role).toBeNull()
  })

  it('reads one folder by id', () => {
    const f = folder(1, 'INBOX')
    expect(getFolder(f.id)?.path).toBe('INBOX')
    expect(getFolder(9999)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `pnpm exec vitest run src/core/store/folderRepo.test.ts`
  - Expected: FAIL; `setFolderRoles` / `folderByRole` / `getFolder` are not exported.

- [ ] **Step 3: Add migration v14.** In `src/core/store/migrate.ts`:
  - Add the import below `import schemaSql …`.
  - Append the entry after the v13 entry, before the closing `]`.

```ts
import { assignRoles } from './folderRoles.js'
```

```ts
  // v14: folder roles. Replaces hardcoded Exmail paths ("Sent Messages",
  // "Deleted Messages") so Gmail's [Gmail]/… and Outlook's "Sent Items"
  // resolve the same way. Backfilled from names here; the next sync refills it
  // from SPECIAL-USE, which wins. One folder per role per account.
  (db) => {
    db.exec('ALTER TABLE folders ADD COLUMN role TEXT')
    const rows = db.prepare('SELECT id, account_id, path FROM folders').all() as {
      id: number
      account_id: number
      path: string
    }[]
    const byAccount = new Map<number, typeof rows>()
    for (const r of rows) byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r])
    const set = db.prepare('UPDATE folders SET role = ? WHERE id = ?')
    for (const list of byAccount.values()) {
      const roles = assignRoles(list.map((r) => ({ path: r.path, specialUse: null })))
      for (const r of list) {
        const role = roles.get(r.path)
        if (role) set.run(role, r.id)
      }
    }
    db.exec(
      'CREATE UNIQUE INDEX idx_folders_role ON folders (account_id, role) WHERE role IS NOT NULL'
    )
  }
```

- [ ] **Step 4: Add `role` to `Folder`.** In `src/core/store/types.ts`:
  - Add at the top of the file:

```ts
import type { FolderRole } from './folderRoles.js'
```

  - Add the field to `interface Folder`, after `last_uid: number`:

```ts
  /** Null for ordinary user folders. Set on every sync. */
  role: FolderRole | null
```

- [ ] **Step 5: Add the repo helpers.** In `src/core/store/repo.ts`:
  - Add the import:

```ts
import type { FolderRole } from './folderRoles.js'
```

  - Add these functions directly after `listFolders`:

```ts
export function getFolder(id: number): Folder | undefined {
  return getDb().prepare('SELECT * FROM folders WHERE id = ?').get(id) as Folder | undefined
}

/**
 * Replaces an account's roles in one transaction. Clearing first lets a role
 * move between folders without a transient clash on idx_folders_role.
 */
export function setFolderRoles(accountId: number, roles: Map<string, FolderRole>): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare('UPDATE folders SET role = NULL WHERE account_id = ?').run(accountId)
    const set = db.prepare('UPDATE folders SET role = ? WHERE account_id = ? AND path = ?')
    for (const [path, role] of roles) set.run(role, accountId, path)
  })()
}

/** The account's folder for a role. Never look special folders up by path. */
export function folderByRole(accountId: number, role: FolderRole): Folder | undefined {
  return getDb()
    .prepare('SELECT * FROM folders WHERE account_id = ? AND role = ?')
    .get(accountId, role) as Folder | undefined
}
```

- [ ] **Step 6: Run the tests and typecheck.**
  - Run: `pnpm exec vitest run src/core/store && pnpm typecheck`
  - Expected: PASS, including the existing `tasks.test.ts` / `threadedList.test.ts`; typecheck clean.

- [ ] **Step 7: Commit.**

```bash
git add src/core/store/migrate.ts src/core/store/types.ts src/core/store/repo.ts src/core/store/folderRepo.test.ts
git commit -m "[feat] store folder roles and look folders up by role"
```

---

### Task 3: Sync writes roles

**Files:**
- Modify: `src/core/sync/syncEngine.ts` (inside `syncAccount`, after the `upsertFolder` loop)
- Modify: `src/core/sync/bodySync.ts` (folder sort)

- [ ] **Step 1: Write roles each sync.** In `syncEngine.ts`:
  - Add `setFolderRoles` to the `../store/repo.js` import list.
  - Add `import { assignRoles } from '../store/folderRoles.js'`.
  - Directly after the `for (const b of boxes) { … upsertFolder … }` loop, insert:

```ts
    // SPECIAL-USE where the server offers it (Gmail, Outlook), names otherwise
    // (Exmail). Recomputed every pass so a renamed folder cannot keep a role.
    setFolderRoles(
      accountId,
      assignRoles(boxes.filter((b) => b.selectable && !isIgnoredFolder(b.path)))
    )
```

- [ ] **Step 2: Sort INBOX first by role.**
  - In `syncEngine.ts`, replace

```ts
    const folders = listFolders(accountId).sort((a, b) =>
      a.path === 'INBOX' ? -1 : b.path === 'INBOX' ? 1 : 0
    )
```

  with

```ts
    const folders = listFolders(accountId).sort((a, b) =>
      a.role === 'inbox' ? -1 : b.role === 'inbox' ? 1 : 0
    )
```

  - In `bodySync.ts`, make the same replacement: `a.path === 'INBOX' ? -1 : b.path === 'INBOX' ? 1 : 0` becomes `a.role === 'inbox' ? -1 : b.role === 'inbox' ? 1 : 0`.

- [ ] **Step 3: Typecheck and test.**
  - Run: `pnpm typecheck && pnpm test`
  - Expected: clean / PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/core/sync/syncEngine.ts src/core/sync/bodySync.ts
git commit -m "[feat] assign folder roles on every sync"
```

---

### Task 4: Main process looks special folders up by role

**Files:**
- Modify: `electron/ipc.ts` (trash, drafts)
- Modify: `src/core/send/flush.ts` (`SENT_PATHS`, `appendToSent`)
- Modify: `electron/workers.ts` (`SENT_PATHS`, `refreshSentFolder`)

- [ ] **Step 1: Trash by role in `electron/ipc.ts`.**
  - Delete the `// Exmail has no Archive mailbox…` comment, `const TRASH_PATHS`, and the whole `resolveTrashPath` function.
  - In the `'messages:move'` handler, replace

```ts
      const toPath = resolveTrashPath(s.accountId)
      if (!toPath) return { ok: false as const, error: 'no trash folder' }
      const dest = findFolderByPath(s.accountId, toPath)
      if (!dest) return { ok: false as const, error: 'no trash folder' }
```

  with

```ts
      const dest = folderByRole(s.accountId, 'trash')
      if (!dest) return { ok: false as const, error: 'no trash folder' }
      const toPath = dest.path
```

- [ ] **Step 2: Drafts by role in `electron/ipc.ts`.**
  - In `'messages:listDrafts'`, replace `findFolderByPath(s.accountId, 'Drafts')` with `folderByRole(s.accountId, 'drafts')`.
  - Do the same in `'messages:count'`.
  - Add `folderByRole` to the `../src/core/store/repo.js` import. Remove `findFolderByPath` from it if nothing else uses it (`noUnusedLocals` will tell you).

- [ ] **Step 3: Sent by role in `src/core/send/flush.ts`.**
  - Delete `const SENT_PATHS = …`.
  - In `appendToSent`, replace

```ts
  // APPEND takes an explicit mailbox, so it needs no SELECT at all.
  let path: string | null = null
  for (const p of SENT_PATHS) {
    if (findFolderByPath(row.account_id, p)) {
      path = p
      break
    }
  }
  if (!path) path = 'Sent Messages'
```

  with

```ts
  // APPEND takes an explicit mailbox, so it needs no SELECT at all. The
  // fallback is Exmail's name, for an account whose first sync has not run.
  const path = folderByRole(row.account_id, 'sent')?.path ?? 'Sent Messages'
```

  - Change `client.append(path as string, …)` to `client.append(path, …)`.
  - Import `folderByRole` from `../store/repo.js`, and drop `findFolderByPath` there if it is now unused.

- [ ] **Step 4: Sent by role in `electron/workers.ts`.**
  - Delete `/** Exmail uses "Sent Messages"; other hosts vary. */` and `const SENT_PATHS = …`.
  - In `refreshSentFolder`, replace

```ts
  const path = SENT_PATHS.map((p) => findFolderByPath(accountId, p)).find(Boolean)?.path
```

  with

```ts
  const path = folderByRole(accountId, 'sent')?.path
```

  - Change the import to `import { findFolderByPath, folderByRole } from '../src/core/store/repo.js'`. `findFolderByPath` is still used inside the poll loop.

- [ ] **Step 5: Confirm no hardcoded paths are left in main.**
  - Run: `grep -rn "Sent Messages\|Deleted Messages\|'Drafts'" electron src/core --include=*.ts | grep -v test`
  - Expected: only the `'Sent Messages'` fallback in `flush.ts` and the name lists in `folderRoles.ts`.

- [ ] **Step 6: Typecheck and test.**
  - Run: `pnpm typecheck && pnpm test`
  - Expected: clean / PASS.

- [ ] **Step 7: Commit.**

```bash
git add electron/ipc.ts electron/workers.ts src/core/send/flush.ts
git commit -m "[refactor] find trash, drafts and sent by role, not by path"
```

---

### Task 5: UI uses roles for labels, icons, order and navigation

**Files:**
- Modify: `src/ui/format.ts`, `src/ui/folderIcons.tsx`, `src/ui/views/Sidebar.tsx`, `src/ui/App.tsx`
- Test: `src/ui/folderLabel.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// src/ui/folderLabel.test.ts
import { describe, expect, it } from 'vitest'
import { folderLabel } from './format.js'

describe('folderLabel', () => {
  it('names special folders by role, whatever the server path', () => {
    expect(folderLabel({ path: 'Sent Messages', name: 'Sent Messages', role: 'sent' })).toBe('Sent')
    expect(folderLabel({ path: '[Gmail]/Sent Mail', name: 'Sent Mail', role: 'sent' })).toBe('Sent')
    expect(folderLabel({ path: 'Deleted Messages', name: null, role: 'trash' })).toBe('Trash')
    expect(folderLabel({ path: '[Gmail]/All Mail', name: 'All Mail', role: 'all' })).toBe('All Mail')
  })

  it('keeps the name of a custom folder', () => {
    expect(folderLabel({ path: '客户', name: '客户', role: null })).toBe('客户')
  })

  it('falls back to the leaf of the path', () => {
    expect(folderLabel({ path: 'Projects/2026', name: null, role: null })).toBe('2026')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `pnpm exec vitest run src/ui/folderLabel.test.ts`
  - Expected: FAIL, because `folderLabel` still takes `(path, name)`.

- [ ] **Step 3: Label by role in `src/ui/format.ts`.** Replace the `// Exmail's IMAP paths are verbose…` comment, `FOLDER_LABELS`, and `folderLabel` with:

```ts
const ROLE_LABELS: Record<FolderRole, string> = {
  inbox: 'Inbox',
  sent: 'Sent',
  drafts: 'Drafts',
  trash: 'Trash',
  junk: 'Junk',
  archive: 'Archive',
  all: 'All Mail'
}

/**
 * Special folders get a clean label whatever the server calls them
 * ("Sent Messages", "[Gmail]/Sent Mail"); custom folders (客户/询价/跟进) keep
 * their own name, or the leaf of the path.
 */
export function folderLabel(f: Pick<Folder, 'path' | 'name' | 'role'>): string {
  if (f.role) return ROLE_LABELS[f.role]
  return f.name ?? f.path.split('/').pop() ?? f.path
}
```

  Add these imports at the top of `format.ts`:

```ts
import type { Folder } from '../core/store/types'
import type { FolderRole } from '../core/store/folderRoles'
```

- [ ] **Step 4: Icon by role.** Replace all of `src/ui/folderIcons.tsx` with:

```tsx
import {
  Archive,
  Clock,
  FileText,
  Folder as FolderIcon,
  Inbox,
  Mails,
  Send,
  ShieldAlert,
  Tag,
  Trash2,
  Users,
  type LucideIcon
} from 'lucide-react'
import type { Folder } from '../core/store/types'
import type { FolderRole } from '../core/store/folderRoles'

const BY_ROLE: Record<FolderRole, LucideIcon> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileText,
  junk: ShieldAlert,
  trash: Trash2,
  archive: Archive,
  all: Mails
}

// The user's custom Chinese folders, by leaf name.
const BY_LEAF: Record<string, LucideIcon> = {
  客户: Users, // customers
  询价: Tag, // inquiries / quotes
  跟进: Clock // follow-ups
}

export function folderIcon(f: Pick<Folder, 'path' | 'role'>): LucideIcon {
  if (f.role) return BY_ROLE[f.role]
  const leaf = f.path.split('/').pop() ?? f.path
  return BY_LEAF[leaf] ?? FolderIcon
}
```

- [ ] **Step 5: Order the sidebar by role.** In `src/ui/views/Sidebar.tsx`:
  - Replace `ORDER` and `rank` with:

```ts
/** Special folders first, in the order a human expects them. */
const ORDER: FolderRole[] = ['inbox', 'drafts', 'sent', 'archive', 'all', 'junk', 'trash']

function rank(f: Folder): number {
  const i = f.role ? ORDER.indexOf(f.role) : -1
  return i === -1 ? ORDER.length : i
}
```

  - Change the sort to `(a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path)`.
  - Change `folderIcon(f.path)` to `folderIcon(f)`, and `folderLabel(f.path, f.name)` to `folderLabel(f)`.
  - Add `import type { FolderRole } from '../../core/store/folderRoles'`.

- [ ] **Step 6: Navigate by role in `src/ui/App.tsx`.**
  - Add `import type { FolderRole } from '../core/store/folderRoles'`.
  - Replace `const OUTGOING_PATHS = ['Sent Messages', 'Sent', 'INBOX.Sent', 'Drafts']` with `const OUTGOING_ROLES: FolderRole[] = ['sent', 'drafts']`.
  - In `showRecipient`, replace `return f ? OUTGOING_PATHS.includes(f.path) : false` with `return f?.role ? OUTGOING_ROLES.includes(f.role) : false`.
  - In `isDraftsFolder`, replace `return f?.path === 'Drafts'` with `return f?.role === 'drafts'`.
  - In the boot effect, replace both `find((f) => f.path === 'INBOX')` with `find((f) => f.role === 'inbox')`.
  - Replace `gotoFolder` with:

```ts
  const gotoFolder = useCallback(
    (role: FolderRole) => {
      const f = useStore.getState().folders.find((x) => x.role === role)
      if (f) void onFolder(f.id)
    },
    [onFolder]
  )
```

  - In the `g`-chord effect, replace the `GOTO` object with `const GOTO: Record<string, FolderRole> = { i: 'inbox', s: 'sent', t: 'trash', d: 'drafts', j: 'junk' }`, and change `const path = GOTO[e.key]` / `gotoFolder(path)` to `const role = GOTO[e.key]` / `gotoFolder(role)` (and `if (path)` to `if (role)`).
  - In `paletteActions`, change `gotoFolder('INBOX')`, `gotoFolder('Sent Messages')`, `gotoFolder('Deleted Messages')` and `gotoFolder('Drafts')` to `gotoFolder('inbox')`, `gotoFolder('sent')`, `gotoFolder('trash')` and `gotoFolder('drafts')`.
  - Change both `folderLabel(active.path, active.name)` to `folderLabel(active)`.

- [ ] **Step 7: Run the tests, typecheck and grep.**
  - Run: `pnpm exec vitest run src/ui && pnpm typecheck`
  - Expected: PASS / clean.
  - Run: `grep -rn "Sent Messages\|Deleted Messages\|'INBOX'\|'Drafts'" src/ui`
  - Expected: no matches.

- [ ] **Step 8: Commit.**

```bash
git add src/ui/format.ts src/ui/folderIcons.tsx src/ui/views/Sidebar.tsx src/ui/App.tsx src/ui/folderLabel.test.ts
git commit -m "[refactor] label, order and navigate folders by role"
```

---

### Task 6: Message handlers act on the owning account

**Files:**
- Modify: `src/core/store/repo.ts` (messages section)
- Modify: `electron/ipc.ts` (`message:toggleFlag`, `messages:setFlag`, `message:body`)
- Test: `src/core/store/ownership.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// src/core/store/ownership.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import { accountOfMessage, groupByAccount } from './repo.js'

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'owner-')), 't.db'))
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (1,'a@b.test'),(2,'c@d.test')").run()
  db.prepare('INSERT INTO messages (id, account_id) VALUES (10,1),(11,2),(12,1)').run()
})

describe('message ownership', () => {
  it('finds the account that owns a message', () => {
    expect(accountOfMessage(11)).toBe(2)
    expect(accountOfMessage(999)).toBeNull()
  })

  it('groups ids by account, keeping order and dropping unknown ids', () => {
    expect([...groupByAccount([12, 11, 999, 10])]).toEqual([
      [1, [12, 10]],
      [2, [11]]
    ])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `pnpm exec vitest run src/core/store/ownership.test.ts`
  - Expected: FAIL, missing exports.

- [ ] **Step 3: Implement in `repo.ts`.** Add directly after `getMessage`:

```ts
/** Owning account of a message, or null once it is gone. */
export function accountOfMessage(id: number): number | null {
  const row = getDb().prepare('SELECT account_id FROM messages WHERE id = ?').get(id) as
    | { account_id: number }
    | undefined
  return row?.account_id ?? null
}

/** Message ids by owning account, in input order. Unknown ids are dropped. */
export function groupByAccount(ids: number[]): Map<number, number[]> {
  const out = new Map<number, number[]>()
  for (const id of ids) {
    const accountId = accountOfMessage(id)
    if (accountId === null) continue
    const list = out.get(accountId)
    if (list) list.push(id)
    else out.set(accountId, [id])
  }
  return out
}
```

- [ ] **Step 4: Run it and confirm it passes.**
  - Run: `pnpm exec vitest run src/core/store/ownership.test.ts`
  - Expected: PASS.

- [ ] **Step 5: Use the owner in `electron/ipc.ts`.**
  - Add `accountOfMessage` and `groupByAccount` to the repo import.
  - Add `type LiveAccount` to the `./state.js` import.
  - Add this helper after `moveWriterFor`:

```ts
/**
 * The live account that owns a message. Handlers acting on a message must use
 * this rather than the active account: the user can switch accounts while an
 * old row is still on screen, and a unified inbox will mix accounts.
 */
function ownerOf(messageId: number): LiveAccount | null {
  const accountId = accountOfMessage(messageId)
  return accountId === null ? null : getAccount(accountId)
}
```

  - Replace the `'message:toggleFlag'` handler body with:

```ts
  ipcMain.handle('message:toggleFlag', (_e, id: number, flag: string) => {
    const acct = ownerOf(id)
    if (!acct) return { ok: false as const, error: 'message not found' }
    const next = toggleFlag(id, flag)
    const nowHas = next.some((f) => f.toLowerCase() === flag.toLowerCase())
    flagWriterFor(acct.accountId, acct.config).enqueue({ messageId: id, flag, add: nowHas })
    return { ok: true as const, flags: next }
  })
```

  - Replace the `'messages:setFlag'` handler body with:

```ts
  ipcMain.handle(
    'messages:setFlag',
    (_e, ids: number[], flag: string, add: boolean) => {
      const updated: { id: number; flags: string[] }[] = []
      for (const [accountId, own] of groupByAccount(ids)) {
        const acct = getAccount(accountId)
        if (!acct) continue
        const writer = flagWriterFor(accountId, acct.config)
        for (const id of own) {
          const next = add ? addFlag(id, flag) : removeFlag(id, flag)
          if (!next) continue
          writer.enqueue({ messageId: id, flag, add })
          updated.push({ id, flags: next })
        }
      }
      return { ok: true as const, updated }
    }
  )
```

  - In `'message:body'`, replace

```ts
      const s = getBootState()
      if (!s.ok) return { ok: false as const, error: s.error }
      try {
        const msg = await ensureBody(s.accountId, s.config, messageId)
```

  with

```ts
      const acct = ownerOf(messageId)
      if (!acct) return { ok: false as const, error: 'message not found' }
      try {
        const msg = await ensureBody(acct.accountId, acct.config, messageId)
```

- [ ] **Step 6: Typecheck and test.**
  - Run: `pnpm typecheck && pnpm test`
  - Expected: clean / PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/core/store/repo.ts src/core/store/ownership.test.ts electron/ipc.ts
git commit -m "[fix] act on the account that owns a message, not the active one"
```

> Thread handlers (`thread:get` / `markRead` / `markUnread`) still use the active account. They take a thread id, which collides across accounts, so moving them needs `account_id` on list rows. That belongs with the unified inbox (Phase 3). Today the UI shows one account at a time, so this is correct for now.

---

### Task 7: Persisted move queue

**Files:**
- Modify: `src/core/store/migrate.ts` (append v15)
- Create: `src/core/store/moveJobs.ts`
- Rewrite: `src/core/sync/moveWriter.ts`
- Modify: `electron/ipc.ts` (`moveWriterFor`, new `resumePendingMoves`, `runSyncFor`)
- Modify: `electron/main.ts` (boot)
- Test: `src/core/sync/moveWriter.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// src/core/sync/moveWriter.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { insertMoveJob, listMoveJobs } from '../store/moveJobs.js'
import type { AccountConfig } from '../accounts/config.js'
import { MissingMailbox, MoveWriter, type MoveRequest } from './moveWriter.js'

const ACC = 1
// The mover is injected, so the IMAP config is never read.
const config = {} as AccountConfig
const job: MoveRequest = { fromPath: 'INBOX', uid: 7, toPath: 'Trash' }

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'moves-')), 't.db'))
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (?,'a@b.test')").run(ACC)
})

const rejected = (): Error => Object.assign(new Error('NO'), { responseStatus: 'NO' })

describe('MoveWriter', () => {
  it('keeps a job on disk until the server confirms it', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const w = new MoveWriter(ACC, config, { move: () => gate })
    w.enqueue(job)
    expect(listMoveJobs(ACC)).toHaveLength(1)
    release()
    await w.whenIdle()
    expect(listMoveJobs(ACC)).toHaveLength(0)
  })

  it('retries a transient failure', async () => {
    const calls: MoveRequest[] = []
    const w = new MoveWriter(ACC, config, {
      retryBaseMs: 0,
      move: async (j) => {
        calls.push(j)
        if (calls.length === 1) throw new Error('socket closed')
      }
    })
    w.enqueue(job)
    await w.whenIdle()
    expect(calls).toEqual([job, job])
    expect(listMoveJobs(ACC)).toHaveLength(0)
  })

  it('drops a job the server rejects', async () => {
    const w = new MoveWriter(ACC, config, {
      retryBaseMs: 0,
      move: async () => {
        throw rejected()
      }
    })
    w.enqueue(job)
    await w.whenIdle()
    expect(listMoveJobs(ACC)).toHaveLength(0)
  })

  it('drops a job whose destination does not exist', async () => {
    const w = new MoveWriter(ACC, config, {
      move: async () => {
        throw new MissingMailbox('Trash')
      }
    })
    w.enqueue(job)
    await w.whenIdle()
    expect(listMoveJobs(ACC)).toHaveLength(0)
  })

  it('keeps a job that never got through, for the next launch', async () => {
    const w = new MoveWriter(ACC, config, {
      retryBaseMs: 0,
      move: async () => {
        throw new Error('offline')
      }
    })
    w.enqueue(job)
    await w.whenIdle()
    expect(listMoveJobs(ACC)).toEqual([
      expect.objectContaining({ from_path: 'INBOX', uid: 7, to_path: 'Trash' })
    ])
  })

  it('replays persisted jobs on resume', async () => {
    insertMoveJob({ account_id: ACC, from_path: 'INBOX', uid: 9, to_path: 'Archive' })
    const calls: MoveRequest[] = []
    const w = new MoveWriter(ACC, config, {
      move: async (j) => {
        calls.push(j)
      }
    })
    w.resume()
    await w.whenIdle()
    expect(calls).toEqual([{ fromPath: 'INBOX', uid: 9, toPath: 'Archive' }])
    expect(listMoveJobs(ACC)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `pnpm exec vitest run src/core/sync/moveWriter.test.ts`
  - Expected: FAIL, "Failed to resolve import ../store/moveJobs.js".

- [ ] **Step 3: Add migration v15.** Append to `migrations` in `migrate.ts`:

```ts
  // v15: IMAP moves the server has not confirmed yet. Written before the
  // MOVE runs and deleted once it settles, so a quit or crash in between is
  // replayed at the next boot instead of leaving SQLite and the server apart.
  (db) =>
    db.exec(`
CREATE TABLE IF NOT EXISTS move_jobs (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_path TEXT NOT NULL,
  uid INTEGER NOT NULL,
  to_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_move_jobs_account ON move_jobs (account_id, id);
`)
```

- [ ] **Step 4: Create `src/core/store/moveJobs.ts`.**

```ts
import { getDb } from './db.js'

export interface MoveJobRow {
  id: number
  account_id: number
  from_path: string
  uid: number
  to_path: string
}

export function insertMoveJob(j: {
  account_id: number
  from_path: string
  uid: number
  to_path: string
}): number {
  const r = getDb()
    .prepare(
      `INSERT INTO move_jobs (account_id, from_path, uid, to_path, created_at)
       VALUES (@account_id, @from_path, @uid, @to_path, @created_at)`
    )
    .run({ ...j, created_at: Date.now() })
  return Number(r.lastInsertRowid)
}

/** Oldest first, so a replay keeps the order the user acted in. */
export function listMoveJobs(accountId: number): MoveJobRow[] {
  return getDb()
    .prepare(
      'SELECT id, account_id, from_path, uid, to_path FROM move_jobs WHERE account_id = ? ORDER BY id'
    )
    .all(accountId) as MoveJobRow[]
}

export function deleteMoveJob(id: number): void {
  getDb().prepare('DELETE FROM move_jobs WHERE id = ?').run(id)
}
```

- [ ] **Step 5: Rewrite `src/core/sync/moveWriter.ts`.**

```ts
import type { ImapFlow } from 'imapflow'
import type { AccountConfig } from '../accounts/config.js'
import { deleteMoveJob, insertMoveJob, listMoveJobs } from '../store/moveJobs.js'
import { listMailboxes, moveUid } from './imap.js'
import { getPool } from './pool.js'

/**
 * Background IMAP MOVE. The UI moves rows in SQLite first; this writes the
 * server move using the source path+uid captured at enqueue time (the local
 * uid is cleared by the optimistic move).
 *
 * Every job is on disk before it runs and deleted once it settles, so a quit,
 * crash or offline spell is replayed by resume() rather than lost. Replay is
 * safe: a UID MOVE of a uid that already left the mailbox is a no-op.
 */
export interface MoveRequest {
  fromPath: string
  uid: number
  toPath: string
}

export type MoveFn = (job: MoveRequest) => Promise<void>

interface Job extends MoveRequest {
  rowId: number
  attempt: number
}

/** Signals an unreachable destination, which retrying cannot fix. */
export class MissingMailbox extends Error {}

const MAX_ATTEMPTS = 4
const RETRY_BASE_MS = 1_000

/** A NO/BAD reply means the server rejected the command — retrying can't help. */
function isPermanent(err: unknown): boolean {
  const status = (err as { responseStatus?: string } | null)?.responseStatus
  return status === 'NO' || status === 'BAD'
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export class MoveWriter {
  private queue: Job[] = []
  private draining: Promise<void> | null = null
  private paths: Set<string> | null = null
  private move: MoveFn
  private retryBaseMs: number

  constructor(
    private accountId: number,
    private config: AccountConfig,
    opts: { move?: MoveFn; retryBaseMs?: number } = {}
  ) {
    this.move = opts.move ?? ((job) => this.imapMove(job))
    this.retryBaseMs = opts.retryBaseMs ?? RETRY_BASE_MS
  }

  enqueue(job: MoveRequest): void {
    const rowId = insertMoveJob({
      account_id: this.accountId,
      from_path: job.fromPath,
      uid: job.uid,
      to_path: job.toPath
    })
    this.queue.push({ ...job, rowId, attempt: 0 })
    void this.drain()
  }

  /** Re-queues every persisted job not already queued, with a fresh retry budget. */
  resume(): void {
    const queued = new Set(this.queue.map((j) => j.rowId))
    for (const r of listMoveJobs(this.accountId)) {
      if (queued.has(r.id)) continue
      this.queue.push({
        rowId: r.id,
        fromPath: r.from_path,
        uid: r.uid,
        toPath: r.to_path,
        attempt: 0
      })
    }
    void this.drain()
  }

  /** Resolves once the queue is empty. */
  async whenIdle(): Promise<void> {
    while (this.draining) await this.draining
  }

  private drain(): Promise<void> {
    if (!this.draining) {
      this.draining = this.run().finally(() => {
        this.draining = null
        // A job enqueued while run() was finishing would otherwise wait for
        // the next enqueue.
        if (this.queue.length) void this.drain()
      })
    }
    return this.draining
  }

  private async run(): Promise<void> {
    while (this.queue.length) {
      const job = this.queue.shift()!
      try {
        await this.move({ fromPath: job.fromPath, uid: job.uid, toPath: job.toPath })
        deleteMoveJob(job.rowId)
      } catch (err) {
        if (err instanceof MissingMailbox) {
          console.error(
            `[moveWriter] destination mailbox "${job.toPath}" does not exist — ${job.fromPath}:${job.uid} left in place`
          )
          deleteMoveJob(job.rowId)
          continue
        }
        if (isPermanent(err)) {
          console.error(
            `[moveWriter] server rejected moving ${job.fromPath}:${job.uid} to ${job.toPath}:`,
            err
          )
          deleteMoveJob(job.rowId)
          continue
        }
        const attempt = job.attempt + 1
        if (attempt >= MAX_ATTEMPTS) {
          // Most likely offline. The row stays on disk; resume() retries it
          // after the next successful sync or at the next launch.
          console.error(
            `[moveWriter] deferring ${job.fromPath}:${job.uid} -> ${job.toPath} after ${attempt} attempt(s):`,
            err
          )
          continue
        }
        // Re-queue at the tail so a failing job never blocks the rest.
        this.queue.push({ ...job, attempt })
        await delay(this.retryBaseMs * 2 ** (attempt - 1))
      }
    }
  }

  /** Cached; a miss re-lists once in case the folder was created after boot. */
  private async mailboxExists(client: ImapFlow, path: string): Promise<boolean> {
    if (this.paths?.has(path)) return true
    const boxes = await listMailboxes(client)
    this.paths = new Set(boxes.filter((b) => b.selectable).map((b) => b.path))
    return this.paths.has(path)
  }

  private imapMove(job: MoveRequest): Promise<void> {
    return getPool(this.config).withConnection(async (client) => {
      // Moving into a mailbox that doesn't exist would lose the message.
      if (!(await this.mailboxExists(client, job.toPath))) throw new MissingMailbox(job.toPath)
      await moveUid(client, job.fromPath, job.uid, job.toPath)
    })
  }
}
```

- [ ] **Step 6: Run the test and confirm it passes.**
  - Run: `pnpm exec vitest run src/core/sync/moveWriter.test.ts`
  - Expected: PASS (6 tests).

- [ ] **Step 7: Wire it in `electron/ipc.ts`.**
  - In `moveWriterFor`, change `new MoveWriter(config)` to `new MoveWriter(accountId, config)`.
  - Add after `moveWriterFor`:

```ts
/** Replays IMAP moves a previous run accepted but never confirmed. */
export function resumePendingMoves(accountId: number, config: AccountConfig): void {
  moveWriterFor(accountId, config).resume()
}
```

  - In `runSyncFor`, directly after `const result = await syncAccount(…)` completes (before the rethread block), add:

```ts
    // The server just answered, so moves deferred while offline can go now.
    resumePendingMoves(s.accountId, s.config)
```

- [ ] **Step 8: Resume at boot in `electron/main.ts`.**
  - Change the import to `import { flushPendingMoves, registerIpc, resumePendingMoves, runSyncFor } from './ipc.js'`.
  - Replace `for (const a of listAccounts()) startAccountWorkers(a.config)` with:

```ts
  for (const a of listAccounts()) {
    startAccountWorkers(a.config)
    resumePendingMoves(a.accountId, a.config)
  }
```

- [ ] **Step 9: Typecheck and test.**
  - Run: `pnpm typecheck && pnpm test`
  - Expected: clean / PASS.

- [ ] **Step 10: Commit.**

```bash
git add src/core/store/migrate.ts src/core/store/moveJobs.ts src/core/sync/moveWriter.ts src/core/sync/moveWriter.test.ts electron/ipc.ts electron/main.ts
git commit -m "[feat] persist pending IMAP moves and replay them after a restart"
```

---

### Task 8: Move to any role or folder

**Files:**
- Modify: `electron/ipc.ts` (`'messages:move'`)
- Modify: `electron/preload.ts` (`moveMessages`)
- Modify: `src/ui/App.tsx` (`moveSelected`, `triageSelected`)

- [ ] **Step 1: Generalize the handler in `electron/ipc.ts`.**
  - Add `import type { MoveTarget } from '../src/core/store/folderRoles.js'`.
  - Add `getFolder` to the repo import, and `import type { Folder } from '../src/core/store/types.js'`.
  - Add these helpers above `registerIpc`:

```ts
function resolveMoveTarget(accountId: number, target: MoveTarget): Folder | undefined {
  if ('role' in target) return folderByRole(accountId, target.role)
  const f = getFolder(target.folderId)
  return f?.account_id === accountId ? f : undefined
}

function missingTargetError(target: MoveTarget): string {
  return 'role' in target ? `no ${target.role} folder` : 'unknown folder'
}
```

  - Replace the whole `'messages:move'` handler with:

```ts
  // Optimistic local move now; the IMAP MOVE is held for UNDO_MOVE_MS so undo
  // is a local rollback rather than a compensating reverse MOVE on the server.
  ipcMain.handle('messages:move', (_e, ids: number[], target: MoveTarget) => {
    // Resolve every destination before touching SQLite, so a missing folder on
    // one account cannot leave a half-applied move behind.
    const plan: { job: PendingMove; destId: number }[] = []
    for (const [accountId, own] of groupByAccount(ids)) {
      if (!getAccount(accountId)) continue
      const dest = resolveMoveTarget(accountId, target)
      if (!dest) return { ok: false as const, error: missingTargetError(target) }
      for (const id of own) {
        const loc = getMessageLocation(id)
        // No uid: already mid-move (an earlier optimistic move nulled it).
        if (!loc?.uid || loc.folder_id === dest.id) continue
        plan.push({
          destId: dest.id,
          job: {
            id,
            accountId,
            fromFolderId: loc.folder_id,
            fromPath: loc.path,
            uid: loc.uid,
            toPath: dest.path
          }
        })
      }
    }
    if (!plan.length) return { ok: true as const, batchId: 0, moved: [] }

    for (const p of plan) moveMessage(p.job.id, p.destId)
    const jobs = plan.map((p) => p.job)
    const batchId = ++moveBatchSeq
    const timer = setTimeout(() => commitMove(batchId), UNDO_MOVE_MS)
    pendingMoves.set(batchId, { jobs, timer })
    return { ok: true as const, batchId, moved: jobs.map((j) => j.id) }
  })
```

- [ ] **Step 2: Update the preload.** In `electron/preload.ts`:
  - Add `import type { MoveTarget } from '../src/core/store/folderRoles.js'`.
  - Replace `moveMessages` with:

```ts
  // The IMAP MOVE is deferred for the undo window, so the returned batchId is
  // what undoMove reverses.
  moveMessages: (
    ids: number[],
    target: MoveTarget
  ): Promise<
    { ok: true; batchId: number; moved: number[] } | { ok: false; error: string }
  > => ipcRenderer.invoke('messages:move', ids, target),
```

- [ ] **Step 3: Pass a target from the UI.** In `src/ui/App.tsx`:
  - Change the folder-roles import to `import type { FolderRole, MoveTarget } from '../core/store/folderRoles'`.
  - Change `moveSelected` so it takes the target and the toast verb. Its signature becomes `async (target: MoveTarget, verb: string) => {`.
  - The call becomes `await window.api.moveMessages(ids, target)`.
  - The toast label becomes `` label: `${verb} ${n} message${n === 1 ? '' : 's'}`, ``.
  - In `triageSelected`, change `else await moveSelected()` to `else await moveSelected({ role: 'trash' }, 'Trashed')`.

- [ ] **Step 4: Typecheck and test.**
  - Run: `pnpm typecheck && pnpm test`
  - Expected: clean / PASS.

- [ ] **Step 5: Commit.**

```bash
git add electron/ipc.ts electron/preload.ts src/ui/App.tsx
git commit -m "[feat] move messages to any folder role or folder"
```

---

### Task 9: Command registry

**Files:**
- Create: `src/ui/commands.ts`, `src/ui/hooks/useKeySequences.ts`, `src/ui/perf.ts` (minimal here; Task 10 tests it)
- Modify: `src/ui/views/ShortcutHelp.tsx`, `src/ui/App.tsx`
- Test: `src/ui/commands.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// src/ui/commands.test.ts
import { describe, expect, it } from 'vitest'
import type { Mode } from './hooks/useHotkeys.js'
import {
  COMMANDS,
  buildBindings,
  buildChords,
  buildPaletteActions,
  buildSequences,
  keyCaps,
  shortcutGroups
} from './commands.js'

const ALL_MODES: Mode[] = ['list', 'thread', 'compose', 'modal']

describe('command registry', () => {
  it('never binds one key twice in the same mode', () => {
    const seen = new Map<string, string>()
    for (const c of COMMANDS) {
      for (const k of c.keys) {
        if (k.kind !== 'key') continue
        for (const m of k.modes ?? ALL_MODES) {
          const slot = `${m}:${k.key}`
          expect(seen.get(slot), `${slot} is bound by ${seen.get(slot)} and ${c.id}`).toBeUndefined()
          seen.set(slot, c.id)
        }
      }
    }
  })

  it('never reuses a ⌘ chord or a sequence', () => {
    const chords = COMMANDS.flatMap((c) => c.keys.filter((k) => k.kind === 'mod').map((k) => k.key))
    expect(new Set(chords).size).toBe(chords.length)
    const seqs = COMMANDS.flatMap((c) =>
      c.keys.flatMap((k) => (k.kind === 'seq' ? [k.keys.join(' ')] : []))
    )
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('never makes a sequence prefix a single-key binding', () => {
    const singles = new Set(
      COMMANDS.flatMap((c) => c.keys.flatMap((k) => (k.kind === 'key' ? [k.key] : [])))
    )
    for (const c of COMMANDS)
      for (const k of c.keys) if (k.kind === 'seq') expect(singles.has(k.keys[0])).toBe(false)
  })

  it('draws keycaps the way the sheet shows them', () => {
    expect(keyCaps({ kind: 'key', key: 'R' })).toEqual(['⇧', 'R'])
    expect(keyCaps({ kind: 'key', key: 'Backspace' })).toEqual(['⌫'])
    expect(keyCaps({ kind: 'mod', key: 'k' })).toEqual(['⌘', 'K'])
    expect(keyCaps({ kind: 'seq', keys: ['g', 'i'] })).toEqual(['g', 'i'])
  })

  it('binds single keys only for commands that have a handler, passing the mode', () => {
    const seen: Mode[] = []
    const bindings = buildBindings('thread', { 'msg.star': ({ mode }) => void seen.push(mode) })
    expect(bindings.map((b) => b.key)).toEqual(['s'])
    // Node has no KeyboardEvent, and the builder's handlers ignore the event.
    bindings[0].handler({} as KeyboardEvent)
    expect(seen).toEqual(['thread'])
  })

  it('never binds compose-editor shortcuts globally', () => {
    const chords = buildChords('list', { 'compose.send': () => {}, 'format.bold': () => {} })
    expect(chords).toEqual([])
  })

  it('offers sequences only in the modes they allow', () => {
    const h = { 'go.inbox': () => {} }
    expect(Object.keys(buildSequences('list', h).g ?? {})).toEqual(['i'])
    expect(buildSequences('thread', h)).toEqual({})
  })

  it('lists palette commands with their shortcut as a hint', () => {
    const actions = buildPaletteActions('modal', { 'go.inbox': () => {}, 'nav.down': () => {} })
    expect(actions.map((a) => [a.id, a.hint])).toEqual([['go.inbox', 'g i']])
  })

  it('puts sequences on the sheet as "then" rows', () => {
    const nav = shortcutGroups().find((g) => g.title === 'Navigation')!
    expect(nav.items.find((i) => i.label === 'Go to Inbox')).toEqual({
      label: 'Go to Inbox',
      keys: ['g', 'i'],
      then: true,
      alt: undefined
    })
  })
})
```

- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `pnpm exec vitest run src/ui/commands.test.ts`
  - Expected: FAIL, "Failed to resolve import ./commands.js".

- [ ] **Step 3: Create `src/ui/perf.ts`.** It is a minimal stub so the registry can use it; Task 10 adds its tests.

```ts
/** Superhuman's bar: an action slower than this on screen is a bug. */
export const ACTION_BUDGET_MS = 100

function defaultReport(name: string, ms: number): void {
  if (import.meta.env.DEV) {
    console.warn(`[perf] ${name} took ${ms.toFixed(1)}ms (budget ${ACTION_BUDGET_MS}ms)`)
  }
}

/** Runs fn and reports it when it overruns the budget. Never swallows errors. */
export async function timed<T>(
  name: string,
  fn: () => T | Promise<T>,
  opts: {
    budgetMs?: number
    now?: () => number
    report?: (name: string, ms: number) => void
  } = {}
): Promise<T> {
  const now = opts.now ?? (() => performance.now())
  const budget = opts.budgetMs ?? ACTION_BUDGET_MS
  const report = opts.report ?? defaultReport
  const start = now()
  try {
    return await fn()
  } finally {
    const ms = now() - start
    if (ms > budget) report(name, ms)
  }
}
```

- [ ] **Step 4: Create `src/ui/commands.ts`.**

```ts
import type { Binding, Mode } from './hooks/useHotkeys'
import type { PaletteAction } from './views/CommandPalette'
import { timed } from './perf'

/**
 * Every user action, declared once. Hotkeys, ⌘ chords, g-sequences, the ⌘K
 * palette and the shortcut sheet are all built from this list, so a shortcut
 * can never work in one place and be missing from another.
 */

export type KeySpec =
  /** A bare key as KeyboardEvent.key reports it: 'j', 'Enter', 'R' (shifted). */
  | { kind: 'key'; key: string; modes?: Mode[] }
  /** Two keys in a row, e.g. g then i. */
  | { kind: 'seq'; keys: [string, string]; modes?: Mode[] }
  /** ⌘ (Ctrl off macOS) plus a key. Live in every mode; handlers decide. */
  | { kind: 'mod'; key: string }

export type Group = 'General' | 'Navigation' | 'Message' | 'In a thread' | 'Compose'

export type CommandId =
  | 'palette.open'
  | 'compose.new'
  | 'settings.open'
  | 'shortcuts.open'
  | 'escape'
  | 'sync.now'
  | 'account.add'
  | 'nav.down'
  | 'nav.up'
  | 'nav.open'
  | 'go.inbox'
  | 'go.sent'
  | 'go.drafts'
  | 'go.trash'
  | 'go.junk'
  | 'msg.star'
  | 'msg.read'
  | 'msg.trash'
  | 'msg.select'
  | 'thread.reply'
  | 'thread.replyAll'
  | 'thread.forward'
  | 'compose.send'
  | 'format.bold'
  | 'format.italic'
  | 'format.underline'

export interface Command {
  id: CommandId
  title: string
  group: Group
  /** First is the primary shortcut; a second shows as "or" on the sheet. */
  keys: KeySpec[]
  /** Offer it in ⌘K. */
  palette?: boolean
  /** Bound by another component (the compose editor); listed on the sheet only. */
  external?: boolean
}

const LIST_THREAD: Mode[] = ['list', 'thread']

export const COMMANDS: Command[] = [
  {
    id: 'palette.open',
    title: 'Search and command menu',
    group: 'General',
    keys: [{ kind: 'mod', key: 'k' }, { kind: 'key', key: '/', modes: LIST_THREAD }]
  },
  {
    id: 'compose.new',
    title: 'Compose new message',
    group: 'General',
    palette: true,
    keys: [{ kind: 'key', key: 'c', modes: LIST_THREAD }]
  },
  { id: 'settings.open', title: 'Settings', group: 'General', palette: true, keys: [{ kind: 'mod', key: ',' }] },
  {
    id: 'shortcuts.open',
    title: 'Keyboard shortcuts',
    group: 'General',
    palette: true,
    keys: [{ kind: 'mod', key: '.' }]
  },
  {
    id: 'escape',
    title: 'Close · clear selection · go back',
    group: 'General',
    keys: [{ kind: 'key', key: 'Escape', modes: LIST_THREAD }]
  },
  { id: 'sync.now', title: 'Sync now', group: 'General', palette: true, keys: [] },
  { id: 'account.add', title: 'Add mailbox…', group: 'General', palette: true, keys: [] },

  { id: 'nav.down', title: 'Move down', group: 'Navigation', keys: [{ kind: 'key', key: 'j', modes: ['list'] }] },
  { id: 'nav.up', title: 'Move up', group: 'Navigation', keys: [{ kind: 'key', key: 'k', modes: ['list'] }] },
  { id: 'nav.open', title: 'Open message', group: 'Navigation', keys: [{ kind: 'key', key: 'Enter', modes: ['list'] }] },
  { id: 'go.inbox', title: 'Go to Inbox', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 'i'], modes: ['list'] }] },
  { id: 'go.sent', title: 'Go to Sent', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 's'], modes: ['list'] }] },
  { id: 'go.drafts', title: 'Go to Drafts', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 'd'], modes: ['list'] }] },
  { id: 'go.trash', title: 'Go to Trash', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 't'], modes: ['list'] }] },
  { id: 'go.junk', title: 'Go to Junk', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 'j'], modes: ['list'] }] },

  { id: 'msg.star', title: 'Star', group: 'Message', keys: [{ kind: 'key', key: 's', modes: LIST_THREAD }] },
  { id: 'msg.read', title: 'Toggle read / unread', group: 'Message', keys: [{ kind: 'key', key: 'u', modes: LIST_THREAD }] },
  // The Mac key labelled "delete" reports as Backspace.
  { id: 'msg.trash', title: 'Trash', group: 'Message', keys: [{ kind: 'key', key: 'Backspace', modes: LIST_THREAD }] },
  { id: 'msg.select', title: 'Select', group: 'Message', keys: [{ kind: 'key', key: 'x', modes: ['list'] }] },

  { id: 'thread.reply', title: 'Reply', group: 'In a thread', keys: [{ kind: 'key', key: 'r', modes: ['thread'] }] },
  { id: 'thread.replyAll', title: 'Reply all', group: 'In a thread', keys: [{ kind: 'key', key: 'R', modes: ['thread'] }] },
  { id: 'thread.forward', title: 'Forward', group: 'In a thread', keys: [{ kind: 'key', key: 'f', modes: ['thread'] }] },

  { id: 'compose.send', title: 'Send', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'Enter' }] },
  { id: 'format.bold', title: 'Bold', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'b' }] },
  { id: 'format.italic', title: 'Italic', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'i' }] },
  { id: 'format.underline', title: 'Underline', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'u' }] }
]

export type Handler = (ctx: { mode: Mode }) => void | Promise<unknown>
export type Handlers = Partial<Record<CommandId, Handler>>

const NAMED: Record<string, string> = {
  Backspace: '⌫',
  Enter: '↵',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓'
}

const cap = (k: string): string => NAMED[k] ?? k

export function keyCaps(spec: KeySpec): string[] {
  if (spec.kind === 'seq') return spec.keys.map(cap)
  if (spec.kind === 'mod') return ['⌘', cap(spec.key).toUpperCase()]
  const k = spec.key
  // A shifted letter arrives as its capital (R); show the Shift it took.
  if (k.length === 1 && k !== k.toLowerCase()) return ['⇧', k]
  return [cap(k)]
}

function hint(spec: KeySpec): string {
  return keyCaps(spec).join(spec.kind === 'seq' ? ' ' : '')
}

/** Commands this component actually handles. */
function live(handlers: Handlers): { cmd: Command; run: Handler }[] {
  return COMMANDS.flatMap((cmd) => {
    const run = handlers[cmd.id]
    return run && !cmd.external ? [{ cmd, run }] : []
  })
}

export function buildBindings(mode: Mode, handlers: Handlers): Binding[] {
  return live(handlers).flatMap(({ cmd, run }) =>
    cmd.keys.flatMap((k) =>
      k.kind === 'key'
        ? [{ key: k.key, modes: k.modes, handler: () => void run({ mode }) }]
        : []
    )
  )
}

export function buildChords(
  mode: Mode,
  handlers: Handlers
): { key: string; handler: () => void }[] {
  return live(handlers).flatMap(({ cmd, run }) =>
    cmd.keys.flatMap((k) =>
      k.kind === 'mod' ? [{ key: k.key, handler: () => void run({ mode }) }] : []
    )
  )
}

/** First key -> second key -> action, for the sequences allowed in `mode`. */
export function buildSequences(
  mode: Mode,
  handlers: Handlers
): Record<string, Record<string, () => void>> {
  const out: Record<string, Record<string, () => void>> = {}
  for (const { cmd, run } of live(handlers)) {
    for (const k of cmd.keys) {
      if (k.kind !== 'seq' || (k.modes && !k.modes.includes(mode))) continue
      const [first, second] = k.keys
      ;(out[first] ??= {})[second] = () => void run({ mode })
    }
  }
  return out
}

export function buildPaletteActions(mode: Mode, handlers: Handlers): PaletteAction[] {
  return live(handlers)
    .filter(({ cmd }) => cmd.palette)
    .map(({ cmd, run }) => ({
      id: cmd.id,
      label: cmd.title,
      hint: cmd.keys[0] ? hint(cmd.keys[0]) : undefined,
      run: () => void run({ mode })
    }))
}

/** Wraps every handler in the 100ms speed budget. */
export function withTiming(handlers: Handlers): Handlers {
  const out: Handlers = {}
  for (const [id, h] of Object.entries(handlers) as [CommandId, Handler][]) {
    out[id] = (ctx) => timed(id, () => h(ctx))
  }
  return out
}

export interface SheetRow {
  label: string
  /** Rendered as separate keycaps; `then` marks a sequence. */
  keys: string[]
  then?: boolean
  /** Equivalent binding, shown after "or". */
  alt?: string[]
}

const GROUP_ORDER: Group[] = ['General', 'Navigation', 'Message', 'In a thread', 'Compose']

export function shortcutGroups(): { title: Group; items: SheetRow[] }[] {
  return GROUP_ORDER.map((title) => ({
    title,
    items: COMMANDS.filter((c) => c.group === title && c.keys.length > 0).map((c) => ({
      label: c.title,
      keys: keyCaps(c.keys[0]),
      then: c.keys[0].kind === 'seq' || undefined,
      alt: c.keys[1] ? keyCaps(c.keys[1]) : undefined
    }))
  })).filter((g) => g.items.length > 0)
}
```

- [ ] **Step 5: Run the test and confirm it passes.**
  - Run: `pnpm exec vitest run src/ui/commands.test.ts`
  - Expected: PASS (9 tests).

- [ ] **Step 6: Create `src/ui/hooks/useKeySequences.ts`.**

```ts
import { useEffect } from 'react'

/**
 * Two-key sequences (g then i). `sequences` maps first key -> second key ->
 * action; an empty map leaves every key alone. Typing in a field never arms it.
 */
export function useKeySequences(
  sequences: Record<string, Record<string, () => void>>,
  timeoutMs = 1200
): void {
  useEffect(() => {
    let first: string | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const disarm = (): void => {
      first = null
      if (timer) clearTimeout(timer)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return

      if (first) {
        const run = sequences[first]?.[e.key]
        disarm()
        if (run) {
          e.preventDefault()
          run()
        }
        return
      }
      if (sequences[e.key]) {
        first = e.key
        timer = setTimeout(disarm, timeoutMs)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      disarm()
    }
  }, [sequences, timeoutMs])
}
```

- [ ] **Step 7: Render the sheet from the registry.** In `src/ui/views/ShortcutHelp.tsx`:
  - Delete `interface Shortcut`, `interface Group`, the `/** Mirrors the bindings in App.tsx … */` comment and the `GROUPS` array.
  - Add in their place:

```ts
import { shortcutGroups } from '../commands'

/** Built from the command registry, so it cannot drift from the real bindings. */
const GROUPS = shortcutGroups()
```

  Move the import to the top with the other imports. The render code is unchanged: it already reads `g.title`, `g.items`, `s.label`, `s.keys`, `s.then` and `s.alt`.

- [ ] **Step 8: Wire `App.tsx` to the registry.**
  - Imports:
    - Add `import { buildBindings, buildChords, buildPaletteActions, buildSequences, withTiming, type Handlers } from './commands'` and `import { useKeySequences } from './hooks/useKeySequences'`.
    - Change `import { useHotkeys, type Binding, type Mode } from './hooks/useHotkeys'` to `import { useHotkeys, type Mode } from './hooks/useHotkeys'`.
  - Delete the whole `useEffect(() => { if (openThread || paletteOpen || compose) return; const GOTO … }, [openThread, paletteOpen, compose, gotoFolder])` block.
  - Keep the `const mode: Mode = …` computation.
  - Replace everything from `const bindings = useMemo<Binding[]>(` through `useCommandChord(chords)` with:

```ts
  const handlers = useMemo<Handlers>(
    () =>
      withTiming({
        'palette.open': ({ mode: m }) => {
          if (m !== 'compose') openPalette()
        },
        'compose.new': startCompose,
        'settings.open': () => setSettingsOpen(true),
        'shortcuts.open': () => setShortcutsOpen(true),
        escape: ({ mode: m }) => {
          if (m === 'thread') closeThread()
          else if (useStore.getState().checkedIds.length) clearChecked()
        },
        'sync.now': () => backgroundSync(),
        'account.add': () => setAddingAccount(true),
        'nav.down': () => moveSelection(1),
        'nav.up': () => moveSelection(-1),
        'nav.open': openSelected,
        'go.inbox': () => gotoFolder('inbox'),
        'go.sent': () => gotoFolder('sent'),
        'go.drafts': () => gotoFolder('drafts'),
        'go.trash': () => gotoFolder('trash'),
        'go.junk': () => gotoFolder('junk'),
        'msg.star': ({ mode: m }) => (m === 'thread' ? starFromThread() : starSelected()),
        // In a thread, u un-reads and leaves, since staying would re-mark it read.
        'msg.read': ({ mode: m }) => (m === 'thread' ? unreadFromThread() : toggleReadSelected()),
        'msg.trash': ({ mode: m }) => (m === 'thread' ? triageFromThread() : triageSelected()),
        'msg.select': () => {
          const { rows: r, selectedIndex: i } = useStore.getState()
          const row = r[i]
          if (row) toggleChecked(row.id, i)
        },
        'thread.reply': () => startReply(false),
        'thread.replyAll': () => startReply(true),
        'thread.forward': () => startForward()
      }),
    [
      openPalette,
      startCompose,
      closeThread,
      clearChecked,
      backgroundSync,
      moveSelection,
      openSelected,
      gotoFolder,
      starFromThread,
      starSelected,
      unreadFromThread,
      toggleReadSelected,
      triageFromThread,
      triageSelected,
      toggleChecked,
      startReply,
      startForward
    ]
  )

  const bindings = useMemo(() => buildBindings(mode, handlers), [mode, handlers])
  useHotkeys(mode, bindings)
  const chords = useMemo(() => buildChords(mode, handlers), [mode, handlers])
  useCommandChord(chords)
  const sequences = useMemo(() => buildSequences(mode, handlers), [mode, handlers])
  useKeySequences(sequences)
```

  - In `paletteActions`:
    - Replace the hand-written `compose`, `inbox`, `sent`, `trash`, `drafts`, `sync`, `settings` and `add-account` entries with `...buildPaletteActions(mode, handlers),`.
    - Keep the `scheduled` entry and the `...scheduled.map(…)` entries after it.
    - Change the deps to `[mode, handlers, scheduled]`.
  - `handlers` references `backgroundSync`, `gotoFolder` and the rest, so place it after all of them. Its current spot, just after `const mode`, already is.

- [ ] **Step 9: Typecheck and test.**
  - Run: `pnpm typecheck && pnpm test`
  - Expected: clean / PASS.
  - `noUnusedLocals` flags any helper that is now unused (for example `applyFlags` should still be used by `starSelected`). Remove only what tsc reports.

- [ ] **Step 10: Commit.**

```bash
git add src/ui/commands.ts src/ui/commands.test.ts src/ui/perf.ts src/ui/hooks/useKeySequences.ts src/ui/views/ShortcutHelp.tsx src/ui/App.tsx
git commit -m "[refactor] one command registry behind hotkeys, palette and shortcut sheet"
```

---

### Task 10: Speed budget tests and neighbor-body prefetch

**Files:**
- Test: `src/ui/perf.test.ts`
- Modify: `electron/ipc.ts` (new `messages:prefetchBodies`)
- Modify: `electron/preload.ts` (`prefetchBodies`)
- Modify: `src/ui/App.tsx` (`openRow`)

- [ ] **Step 1: Write the test.**

```ts
// src/ui/perf.test.ts
import { describe, expect, it } from 'vitest'
import { timed } from './perf.js'

/** A clock that returns the given ticks in order, then sticks on the last. */
function clock(...ticks: number[]): () => number {
  let i = 0
  return () => ticks[Math.min(i++, ticks.length - 1)]
}

describe('timed', () => {
  it('reports an action over budget', async () => {
    const seen: [string, number][] = []
    const out = await timed('msg.trash', () => 'ok', {
      now: clock(0, 150),
      report: (n, ms) => seen.push([n, ms])
    })
    expect(out).toBe('ok')
    expect(seen).toEqual([['msg.trash', 150]])
  })

  it('stays quiet under budget', async () => {
    const seen: unknown[] = []
    await timed('nav.down', () => undefined, { now: clock(0, 40), report: () => seen.push(1) })
    expect(seen).toEqual([])
  })

  it('still reports, and rethrows, when the action fails', async () => {
    const seen: unknown[] = []
    await expect(
      timed(
        'x',
        () => {
          throw new Error('boom')
        },
        { now: clock(0, 500), report: () => seen.push(1) }
      )
    ).rejects.toThrow('boom')
    expect(seen).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it.**
  - Run: `pnpm exec vitest run src/ui/perf.test.ts`
  - Expected: PASS. The implementation already exists from Task 9.
  - If it fails, fix `perf.ts`, not the test.

- [ ] **Step 3: Add the prefetch handler in `electron/ipc.ts`.** Add it inside `registerIpc`, after `'message:body'`:

```ts
  // Warms the bodies either side of the open thread, so auto-advance after a
  // triage opens the next one from SQLite instead of waiting on IMAP.
  ipcMain.handle('messages:prefetchBodies', async (_e, ids: number[]) => {
    for (const id of ids.slice(0, 4)) {
      const acct = ownerOf(id)
      if (!acct) continue
      try {
        await ensureBody(acct.accountId, acct.config, id)
      } catch {
        // Best effort: opening the message retries and reports properly.
      }
    }
  })
```

- [ ] **Step 4: Expose it in the preload.** Add to the `api` object in `electron/preload.ts`, next to `getBody`:

```ts
  prefetchBodies: (ids: number[]): Promise<void> =>
    ipcRenderer.invoke('messages:prefetchBodies', ids),
```

- [ ] **Step 5: Prefetch the neighbors on open.** In `src/ui/App.tsx`, in `openRow`, replace

```ts
      if (row.thread_id) openThreadAndRead(row.thread_id, row.id)
```

with

```ts
      if (row.thread_id) openThreadAndRead(row.thread_id, row.id)
      const neighbors = [r[index + 1]?.id, r[index - 1]?.id].filter(
        (id): id is number => typeof id === 'number'
      )
      if (neighbors.length) void window.api.prefetchBodies(neighbors)
```

- [ ] **Step 6: Typecheck and test.**
  - Run: `pnpm typecheck && pnpm test`
  - Expected: clean / PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/ui/perf.test.ts electron/ipc.ts electron/preload.ts src/ui/App.tsx
git commit -m "[feat] 100ms action budget in dev and prefetch neighbouring bodies"
```

---

### Task 11: Docs and end-to-end check

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `CLAUDE.md`.**
  - Under **Local-first rules**, replace rule 4 with:

```markdown
4. Exmail quirks: STATUS skip, app-specific password. Special folders are found by role (`folders.role`, from SPECIAL-USE then names) — never by path.
```

  - Under **Keyboard**, add as the first bullet:

```markdown
- Every action is declared once in `src/ui/commands.ts`; hotkeys, ⌘ chords, `g` sequences, ⌘K and the shortcut sheet are built from it. Add the command there, then its handler in `App.tsx`. Handlers run inside a 100ms budget that warns in dev.
```

  - Under **Schema**, add:

```markdown
- `folders.role` (`inbox|sent|drafts|trash|junk|archive|all`) is reassigned every sync; one folder per role per account. Use `folderByRole`.
- `move_jobs` holds IMAP moves not yet confirmed; `MoveWriter.resume()` replays them at boot and after each sync.
- Handlers that take message ids act on the owning account (`groupByAccount` / `ownerOf`), not the active one.
```

- [ ] **Step 2: Run the full CI check locally.**
  - Run: `pnpm typecheck && pnpm test && pnpm build`
  - Expected: all three succeed, with a test count of the baseline plus the new files.

- [ ] **Step 3: Manual smoke test in the real app.** This needs the Electron-ABI native module.
  - Run `pnpm exec electron-builder install-app-deps`, then `pnpm dev`, with the existing Exmail account.
  - Check that:
    1. The sidebar shows Inbox, Drafts, Sent, Junk, Trash in that order, with the same labels and icons as before.
    2. `g i` / `g s` / `g d` / `g t` / `g j` jump to the right folders; ⌘K lists "Go to Junk" with the hint `g j`.
    3. ⌘. opens the sheet, and every row matches what the keys actually do.
    4. Trashing with ⌫ and then undoing restores the row; trashing and waiting 3s makes the message appear in Trash in Exmail webmail.
    5. Trash a message, then quit within 3s. On relaunch the move reaches the server (check webmail), and `move_jobs` is empty afterwards: `sqlite3 "<userData>/supermail.db" "select count(*) from move_jobs"`. Find the real DB path in `electron/main.ts` → `initDb(...)`.
    6. Opening a thread and pressing ⌫ auto-advances to the next thread with its body already rendered.
    7. No `[perf]` warnings appear in the devtools console during normal triage, or note any that do.
  - Before running any `pnpm test` again, switch the module back to the Node build with `pnpm rebuild better-sqlite3`.

- [ ] **Step 4: Commit.**

```bash
git add CLAUDE.md
git commit -m "[docs] folder roles, command registry and move queue"
```

---

## Self-review notes

- **Spec coverage (Phase 0):**
  - 0.1 folder roles → Tasks 1–5
  - 0.2 owner-resolved IPC → Task 6. Thread handlers are deferred to Phase 3, as noted in that task.
  - 0.3 command registry → Task 9
  - 0.4 generalized and persisted move queue → Tasks 7–8. FlagWriter persistence is not in scope.
  - 0.5 speed budget and prefetch → Tasks 9 (perf stub) and 10
  - Splitting `App.tsx` is partial (the g-sequence listener and the bindings move out); the rest happens as later phases touch it.
- **Not in Phase 0:**
  - Archive / Done key (Phase 2). `messages:move` with `{ role: 'archive' }` already works for any account that has an archive folder.
  - Creating an Archive folder on Exmail (Phase 2, needs user confirmation).
- **Type names used across tasks:**
  - `FolderRole`, `MoveTarget`, `RoleCandidate` and `assignRoles` from `folderRoles.ts`.
  - `setFolderRoles`, `folderByRole`, `getFolder`, `accountOfMessage` and `groupByAccount` from `repo.ts`.
  - `MoveRequest`, `MoveFn` and `MissingMailbox` from `moveWriter.ts`.
  - `CommandId`, `Handlers`, `withTiming` and the `build*` functions from `commands.ts`.
  - `timed` from `perf.ts`.
