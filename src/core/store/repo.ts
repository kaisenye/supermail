import { getDb } from './db.js'
import type { FolderRole } from './folderRoles.js'
import { validId } from '../pipeline/threadKey.js'
import type {
  Account,
  Folder,
  Message,
  MessageListRow,
  UpsertMessageInput
} from './types.js'

export const LIST_COLS =
  'id, thread_id, from_addr, from_name, to_addrs, subject, date, snippet, flags, has_attachments'

// ---- accounts ----

export function upsertAccount(a: Omit<Account, 'id'>): Account {
  const db = getDb()
  db.prepare(
    `INSERT INTO accounts (email, imap_host, imap_port, smtp_host, smtp_port, auth_ref, provider, auth_type)
     VALUES (@email, @imap_host, @imap_port, @smtp_host, @smtp_port, @auth_ref, @provider, @auth_type)
     ON CONFLICT(email) DO UPDATE SET
       imap_host = excluded.imap_host, imap_port = excluded.imap_port,
       smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port,
       auth_ref  = excluded.auth_ref,
       provider  = excluded.provider, auth_type = excluded.auth_type`
  ).run(a)
  return db.prepare('SELECT * FROM accounts WHERE email = ?').get(a.email) as Account
}

export function listAccounts(): Account[] {
  return getDb().prepare('SELECT * FROM accounts ORDER BY id').all() as Account[]
}

/** Folders and messages go with it via ON DELETE CASCADE. */
export function deleteAccount(accountId: number): void {
  getDb().prepare('DELETE FROM accounts WHERE id = ?').run(accountId)
}

// ---- folders ----

export function upsertFolder(f: {
  account_id: number
  name: string | null
  path: string
  uidvalidity: number | null
}): Folder {
  const db = getDb()
  db.prepare(
    `INSERT INTO folders (account_id, name, path, uidvalidity)
     VALUES (@account_id, @name, @path, @uidvalidity)
     ON CONFLICT(account_id, path) DO UPDATE SET name = excluded.name`
  ).run(f)
  return db
    .prepare('SELECT * FROM folders WHERE account_id = ? AND path = ?')
    .get(f.account_id, f.path) as Folder
}

/**
 * Drops folders we no longer sync. Cascades to their messages, so only call
 * this for folders that are genuinely unwanted, never for a transient miss.
 */
export function deleteFolder(folderId: number): void {
  getDb().prepare('DELETE FROM folders WHERE id = ?').run(folderId)
}

export function listFolders(accountId: number): Folder[] {
  return getDb()
    .prepare('SELECT * FROM folders WHERE account_id = ? ORDER BY path')
    .all(accountId) as Folder[]
}

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

/** Gives one folder a role if no folder of the account has it. False when taken or not found. */
export function setFolderRole(accountId: number, path: string, role: FolderRole): boolean {
  if (folderByRole(accountId, role)) return false
  return (
    getDb()
      .prepare('UPDATE folders SET role = ? WHERE account_id = ? AND path = ? AND role IS NULL')
      .run(role, accountId, path).changes > 0
  )
}

export function setLastUid(folderId: number, uid: number): void {
  getDb()
    .prepare('UPDATE folders SET last_uid = ? WHERE id = ? AND ? > last_uid')
    .run(uid, folderId, uid)
}

/**
 * UIDVALIDITY changed — server renumbered UIDs, so cached messages are
 * meaningless. Drop them and reset the sync anchor.
 */
export function resetFolder(folderId: number, uidvalidity: number): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE folder_id = ?').run(folderId)
    db.prepare('UPDATE folders SET uidvalidity = ?, last_uid = 0 WHERE id = ?').run(
      uidvalidity,
      folderId
    )
  })()
}

// ---- messages ----

export function upsertMessage(input: UpsertMessageInput): number {
  const { references, ...m } = input
  const row = {
    body_text: null,
    body_html: null,
    has_attachments: 0,
    body_fetched: 0,
    entities: null,
    list_unsubscribe: null,
    unsubscribe_one_click: 0,
    bulk: 0,
    // null = "leave stored flags alone"; only IMAP passes a real value.
    flags: null,
    ...m
  }
  // An optimistic move leaves the row in its new folder with uid NULL: the
  // server picks the new uid, and Exmail has no UIDPLUS to say what it was.
  // When sync then finds the message there, give that row the uid so the
  // upsert below updates it instead of inserting a duplicate.
  if (row.folder_id !== null && row.uid !== null && row.message_id) {
    getDb()
      .prepare(
        `UPDATE messages SET uid = @uid
         WHERE id = (SELECT id FROM messages
                     WHERE account_id = @account_id AND folder_id = @folder_id
                       AND message_id = @message_id AND uid IS NULL
                     LIMIT 1)
           AND NOT EXISTS (SELECT 1 FROM messages
                           WHERE account_id = @account_id AND folder_id = @folder_id
                             AND uid = @uid)`
      )
      .run({
        uid: row.uid,
        account_id: row.account_id,
        folder_id: row.folder_id,
        message_id: row.message_id
      })
  }
  const info = getDb()
    .prepare(
      `INSERT INTO messages (
         account_id, folder_id, uid, message_id, thread_id, in_reply_to,
         from_addr, from_name, to_addrs, cc_addrs, subject, date, snippet,
         body_text, body_html, flags, has_attachments, body_fetched, entities,
         list_unsubscribe, unsubscribe_one_click, bulk
       ) VALUES (
         @account_id, @folder_id, @uid, @message_id, @thread_id, @in_reply_to,
         @from_addr, @from_name, @to_addrs, @cc_addrs, @subject, @date, @snippet,
         @body_text, @body_html, @flags, @has_attachments, @body_fetched, @entities,
         @list_unsubscribe, @unsubscribe_one_click, @bulk
       )
       ON CONFLICT(account_id, folder_id, uid) WHERE folder_id IS NOT NULL
       DO UPDATE SET
         -- NULL means the caller has no authority over flags (a body fetch
         -- parses none). An explicit '[]' from IMAP is authoritative and does
         -- clear \\Seen/\\Flagged, so remote "mark unread" propagates.
         flags = COALESCE(excluded.flags, messages.flags),
         -- envelope re-sync must not clobber an already-fetched body
         body_text    = COALESCE(excluded.body_text, messages.body_text),
         body_html    = COALESCE(excluded.body_html, messages.body_html),
         body_fetched = MAX(excluded.body_fetched, messages.body_fetched),
         -- snippet only exists once a body is parsed, so take the new one
         -- whenever the body pass produced it
         snippet      = COALESCE(excluded.snippet, messages.snippet),
         has_attachments = MAX(excluded.has_attachments, messages.has_attachments),
         entities     = COALESCE(excluded.entities, messages.entities),
         list_unsubscribe = COALESCE(excluded.list_unsubscribe, messages.list_unsubscribe),
         unsubscribe_one_click = MAX(excluded.unsubscribe_one_click, messages.unsubscribe_one_click),
         bulk = MAX(excluded.bulk, messages.bulk),
         -- A message still threaded on its own id (or not at all) takes the
         -- new key: Exmail's ENVELOPE has no In-Reply-To, so the body pass can
         -- know more. Any other thread_id came from a pass that saw more than
         -- this one message (the account-wide rethread union), and re-deriving
         -- it per message would split the conversation until every body is in.
         thread_id    = CASE
                          WHEN messages.thread_id IS NULL
                            OR messages.thread_id = messages.message_id
                          THEN COALESCE(excluded.thread_id, messages.thread_id)
                          ELSE messages.thread_id
                        END,
         in_reply_to  = COALESCE(excluded.in_reply_to, messages.in_reply_to)
       RETURNING id`
    )
    .get(row) as { id: number }
  joinMentionedThread(row.account_id, info.id, row.message_id, [
    ...(references ?? []),
    ...(row.in_reply_to ? [row.in_reply_to] : [])
  ])
  return info.id
}

/**
 * Puts a message in the same thread as every stored message it mentions.
 *
 * The account-wide rethread union runs once; after that each message is keyed
 * on its own headers (references[0]). An Exmail chain has gaps — its Sent mail
 * carries In-Reply-To but no References — so a later reply can key on the Sent
 * reply's id while that reply sits in the root's thread, splitting the
 * conversation for good. This is the union step for one message: adopt the
 * thread of the first stored message it mentions (References are root first),
 * and fold in any fragment keyed on one of those ids, on this message's own id
 * (replies that arrived before it), or on its current thread.
 */
function joinMentionedThread(
  accountId: number,
  id: number,
  ownId: string | null,
  mentioned: string[]
): void {
  const own = validId(ownId)
  const ids = [...new Set(mentioned.map(validId).filter((x): x is string => x !== null && x !== own))]
  if (!ids.length && !own) return
  const db = getDb()
  const current = (
    db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(id) as { thread_id: string | null }
  ).thread_id
  if (current === null) return

  let found: { message_id: string; thread_id: string }[] = []
  if (ids.length) {
    found = db
      .prepare(
        `SELECT message_id, thread_id FROM messages
          WHERE account_id = ? AND thread_id IS NOT NULL
            AND message_id IN (${ids.map(() => '?').join(',')})`
      )
      .all(accountId, ...ids) as { message_id: string; thread_id: string }[]
  }
  const threadOf = new Map(found.map((f) => [f.message_id, f.thread_id]))
  const first = ids.find((x) => threadOf.has(x))
  const target = first ? threadOf.get(first)! : current

  const fold = new Set([...ids, ...found.map((f) => f.thread_id), current, ...(own ? [own] : [])])
  fold.delete(target)
  if (!fold.size) return
  db.prepare(
    `UPDATE messages SET thread_id = ?
      WHERE account_id = ? AND thread_id IN (${[...fold].map(() => '?').join(',')})`
  ).run(target, accountId, ...fold)
}

export function setBody(
  id: number,
  body: { body_text: string | null; body_html: string | null; has_attachments?: number }
): void {
  getDb()
    .prepare(
      `UPDATE messages
       SET body_text = ?, body_html = ?, has_attachments = ?, body_fetched = 1
       WHERE id = ?`
    )
    .run(body.body_text, body.body_html, body.has_attachments ?? 0, id)
}

export function setFlags(id: number, flags: string): void {
  getDb().prepare('UPDATE messages SET flags = ? WHERE id = ?').run(flags, id)
}

/**
 * Ensure a flag is present (idempotent add). Returns the new flag array, or
 * null if it was already set — the caller skips the IMAP write in that case.
 */
export function addFlag(id: number, flag: string): string[] | null {
  const row = getDb().prepare('SELECT flags FROM messages WHERE id = ?').get(id) as
    | { flags: string | null }
    | undefined
  const current: string[] = row?.flags ? JSON.parse(row.flags) : []
  if (current.some((f) => f.toLowerCase() === flag.toLowerCase())) return null
  const next = [...current, flag]
  setFlags(id, JSON.stringify(next))
  return next
}

/** Toggle one flag on a message, returning the new flag array. */
export function toggleFlag(id: number, flag: string): string[] {
  const row = getDb().prepare('SELECT flags FROM messages WHERE id = ?').get(id) as
    | { flags: string | null }
    | undefined
  const current: string[] = row?.flags ? JSON.parse(row.flags) : []
  const has = current.some((f) => f.toLowerCase() === flag.toLowerCase())
  const next = has
    ? current.filter((f) => f.toLowerCase() !== flag.toLowerCase())
    : [...current, flag]
  setFlags(id, JSON.stringify(next))
  return next
}

/**
 * Ensure a flag is absent. Returns the new flag array, or null if it was
 * already missing (caller skips the IMAP write).
 */
export function removeFlag(id: number, flag: string): string[] | null {
  const row = getDb().prepare('SELECT flags FROM messages WHERE id = ?').get(id) as
    | { flags: string | null }
    | undefined
  const current: string[] = row?.flags ? JSON.parse(row.flags) : []
  if (!current.some((f) => f.toLowerCase() === flag.toLowerCase())) return null
  const next = current.filter((f) => f.toLowerCase() !== flag.toLowerCase())
  setFlags(id, JSON.stringify(next))
  return next
}

/** Move a message to another folder locally (optimistic; IMAP follows later). */
export function moveMessage(id: number, toFolderId: number): void {
  getDb()
    .prepare('UPDATE messages SET folder_id = ?, uid = NULL WHERE id = ?')
    .run(toFolderId, id)
}

/** Undo an optimistic move: put the row back where it was, uid included. */
export function restoreMessage(id: number, folderId: number, uid: number): void {
  getDb()
    .prepare('UPDATE messages SET folder_id = ?, uid = ? WHERE id = ?')
    .run(folderId, uid, id)
}

/** Soft-remove from the current folder view after trashing (local delete). */
export function deleteMessageLocal(id: number): void {
  getDb().prepare('DELETE FROM messages WHERE id = ?').run(id)
}

export function findFolderByPath(accountId: number, path: string): Folder | undefined {
  return getDb()
    .prepare('SELECT * FROM folders WHERE account_id = ? AND path = ?')
    .get(accountId, path) as Folder | undefined
}

export function getMessage(id: number): Message | undefined {
  return getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id) as
    | Message
    | undefined
}

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
    .prepare(
      'SELECT id FROM messages WHERE account_id = ? AND folder_id = ? AND thread_id = ? ORDER BY id DESC'
    )
    .all(m.account_id, m.folder_id, m.thread_id) as { id: number }[]
  return [id, ...rows.map((r) => r.id).filter((x) => x !== id)]
}

/**
 * Local drafts (folder_id IS NULL) merged with the server Drafts folder.
 * A draft saved locally and later APPENDed to the server exists twice; the
 * local row wins because it is the one compose can still edit.
 */
export interface Contact {
  address: string
  name: string | null
}

/**
 * Address-book autocomplete mined from existing mail — no separate contacts
 * table to keep in sync. Recipients outrank senders because someone you write
 * to is a likelier target than someone who merely mailed you.
 */
export function searchContacts(
  accountId: number,
  query: string,
  limit = 8
): Contact[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`

  return getDb()
    .prepare(
      `WITH people AS (
         SELECT lower(from_addr) addr, from_name nm, 1 w
           FROM messages
          WHERE account_id = @acct AND from_addr IS NOT NULL AND from_addr <> ''
         UNION ALL
         SELECT lower(json_extract(v.value, '$.address')),
                json_extract(v.value, '$.name'), 3
           FROM messages m, json_each(m.to_addrs) v
          WHERE m.account_id = @acct AND json_valid(m.to_addrs)
            AND json_extract(v.value, '$.address') IS NOT NULL
         UNION ALL
         SELECT lower(json_extract(v.value, '$.address')),
                json_extract(v.value, '$.name'), 2
           FROM messages m, json_each(m.cc_addrs) v
          WHERE m.account_id = @acct AND json_valid(m.cc_addrs)
            AND json_extract(v.value, '$.address') IS NOT NULL
       )
       SELECT addr AS address,
              nullif(max(coalesce(nm, '')), '') AS name,
              sum(w) AS score
         FROM people
        WHERE addr <> @self
          AND (addr LIKE @like ESCAPE '\\' OR lower(coalesce(nm, '')) LIKE @like ESCAPE '\\')
        GROUP BY addr
        -- Prefix matches first: typing "bur" should surface burban@ above
        -- someone whose address merely contains it.
        ORDER BY (addr LIKE @prefix ESCAPE '\\') DESC, score DESC, addr
        LIMIT @limit`
    )
    .all({
      acct: accountId,
      self: (accountEmail(accountId) ?? '').toLowerCase(),
      like,
      prefix: `${q.replace(/[%_]/g, (c) => `\\${c}`)}%`,
      limit
    }) as Contact[]
}

function accountEmail(accountId: number): string | null {
  const row = getDb()
    .prepare('SELECT email FROM accounts WHERE id = ?')
    .get(accountId) as { email: string } | undefined
  return row?.email ?? null
}

/** Mirrors listDrafts' WHERE exactly, including the server-twin suppression. */
export function countDrafts(accountId: number, serverFolderId: number | null): number {
  return (
    getDb()
      .prepare(
        `SELECT count(*) c FROM messages
         WHERE account_id = ? AND (folder_id IS NULL OR folder_id = ?)
           AND (folder_id IS NULL OR message_id IS NULL OR message_id NOT IN (
             SELECT message_id FROM messages
             WHERE account_id = ? AND folder_id IS NULL AND message_id IS NOT NULL
           ))`
      )
      .get(accountId, serverFolderId, accountId) as { c: number }
  ).c
}

export function listDrafts(
  accountId: number,
  serverFolderId: number | null,
  limit = 100,
  offset = 0
): MessageListRow[] {
  return getDb()
    .prepare(
      `SELECT ${LIST_COLS} FROM messages
       WHERE account_id = ? AND (folder_id IS NULL OR folder_id = ?)
         AND (folder_id IS NULL OR message_id IS NULL OR message_id NOT IN (
           SELECT message_id FROM messages
           WHERE account_id = ? AND folder_id IS NULL AND message_id IS NOT NULL
         ))
       ORDER BY date DESC LIMIT ? OFFSET ?`
    )
    .all(accountId, serverFolderId, accountId, limit, offset) as MessageListRow[]
}

/**
 * Lowest synced uid in a folder — the anchor for backfilling older mail.
 * Derived rather than stored so no migration is needed; local-only rows
 * (drafts, optimistically moved messages) have a NULL uid and are excluded.
 */
export function oldestSyncedUid(folderId: number): number | null {
  const row = getDb()
    .prepare('SELECT min(uid) u FROM messages WHERE folder_id = ? AND uid IS NOT NULL')
    .get(folderId) as { u: number | null }
  return row.u
}

/**
 * Account-scoped: thread_id derives from Message-ID/References, so two accounts
 * on the same mailing list produce identical ids and would otherwise interleave.
 */
export function getThread(accountId: number, threadId: string): Message[] {
  return getDb()
    .prepare(
      'SELECT * FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY date DESC'
    )
    .all(accountId, threadId) as Message[]
}

/** Folder path for a message — needed to SELECT the right mailbox on fetch. */
export function getMessageLocation(
  id: number
): { uid: number; path: string; folder_id: number; body_fetched: number } | undefined {
  return getDb()
    .prepare(
      `SELECT m.uid, f.path, m.folder_id, m.body_fetched
       FROM messages m JOIN folders f ON f.id = m.folder_id
       WHERE m.id = ?`
    )
    .get(id) as
    | { uid: number; path: string; folder_id: number; body_fetched: number }
    | undefined
}

/** UIDs of messages in a folder that still lack a body, oldest first. */
export function listUnfetchedUids(folderId: number): number[] {
  const rows = getDb()
    .prepare(
      `SELECT uid FROM messages
       WHERE folder_id = ? AND body_fetched = 0 AND uid IS NOT NULL
       ORDER BY date DESC`
    )
    .all(folderId) as { uid: number }[]
  return rows.map((r) => r.uid)
}

export function countUnfetched(accountId: number): number {
  return (
    getDb()
      .prepare(
        'SELECT count(*) c FROM messages WHERE account_id = ? AND body_fetched = 0'
      )
      .get(accountId) as { c: number }
  ).c
}

export function listAttachments(messageId: number): {
  id: number
  filename: string | null
  mime: string | null
  size: number | null
}[] {
  return getDb()
    // Inline parts belong in the body, not the attachment strip.
    .prepare(
      `SELECT id, filename, mime, size FROM attachments
       WHERE message_id = ? AND COALESCE(inline, 0) = 0`
    )
    .all(messageId) as { id: number; filename: string | null; mime: string | null; size: number | null }[]
}

// ---- settings ----

export function getSettings(): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as {
    key: string
    value: string | null
  }[]
  return Object.fromEntries(rows.map((r) => [r.key, r.value ?? '']))
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value)
}

/** Stored uid -> {id, flags} for a folder, so a sync can diff against the server. */
export function listFlagState(
  folderId: number
): { id: number; uid: number; flags: string | null }[] {
  return getDb()
    .prepare(
      `SELECT id, uid, flags FROM messages
       WHERE folder_id = ? AND uid IS NOT NULL`
    )
    .all(folderId) as { id: number; uid: number; flags: string | null }[]
}

/** Inline (cid:) parts for a message, so the body can resolve its images. */
export function listInlineParts(messageId: number): {
  part_id: string | null
  mime: string | null
  storage_path: string | null
}[] {
  return getDb()
    .prepare(
      `SELECT part_id, mime, storage_path FROM attachments
       WHERE message_id = ? AND COALESCE(inline, 0) = 1
         AND part_id IS NOT NULL AND storage_path IS NOT NULL`
    )
    .all(messageId) as {
    part_id: string | null
    mime: string | null
    storage_path: string | null
  }[]
}

/** Single attachment row — the preview/save handlers need its mime. */
export function getAttachment(id: number): {
  id: number
  filename: string | null
  mime: string | null
  size: number | null
} | undefined {
  return getDb()
    .prepare('SELECT id, filename, mime, size FROM attachments WHERE id = ?')
    .get(id) as
    | { id: number; filename: string | null; mime: string | null; size: number | null }
    | undefined
}

export { searchMessages } from './search.js'

// ---- drafts (folder_id IS NULL) ----

export interface DraftInput {
  account_id: number
  to_addrs: string
  cc_addrs?: string | null
  bcc_addrs?: string | null
  subject?: string | null
  body_text?: string | null
  body_html?: string | null
  in_reply_to?: string | null
  references_header?: string | null
  /** JSON array of picked files, so reopening a draft keeps its attachments. */
  draft_attachments?: string | null
  from_addr: string
  from_name?: string | null
}

export function createDraft(input: DraftInput): number {
  const now = Date.now()
  const snippet = (input.body_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
  const info = getDb()
    .prepare(
      `INSERT INTO messages (
         account_id, folder_id, uid, message_id, thread_id, in_reply_to,
         from_addr, from_name, to_addrs, cc_addrs, bcc_addrs, subject, date,
         snippet, body_text, body_html, references_header, draft_attachments,
         flags, has_attachments, body_fetched
       ) VALUES (
         @account_id, NULL, NULL, NULL, NULL, @in_reply_to,
         @from_addr, @from_name, @to_addrs, @cc_addrs, @bcc_addrs, @subject,
         @date, @snippet, @body_text, @body_html, @references_header,
         @draft_attachments, '[]', 0, 1
       )`
    )
    .run({
      account_id: input.account_id,
      in_reply_to: input.in_reply_to ?? null,
      from_addr: input.from_addr,
      from_name: input.from_name ?? null,
      to_addrs: input.to_addrs,
      cc_addrs: input.cc_addrs ?? null,
      bcc_addrs: input.bcc_addrs ?? null,
      subject: input.subject ?? null,
      date: now,
      snippet,
      body_text: input.body_text ?? null,
      body_html: input.body_html ?? null,
      references_header: input.references_header ?? null,
      draft_attachments: input.draft_attachments ?? null
    })
  return Number(info.lastInsertRowid)
}

export function updateDraft(
  id: number,
  patch: {
    to_addrs: string
    cc_addrs?: string | null
    bcc_addrs?: string | null
    subject?: string | null
    body_text?: string | null
    body_html?: string | null
    in_reply_to?: string | null
    references_header?: string | null
    draft_attachments?: string | null
  }
): void {
  const cur = getMessage(id)
  if (!cur || cur.folder_id != null) return
  const body_text = patch.body_text ?? null
  const snippet = (body_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
  // Named params: a positional list here is how a field silently goes missing.
  getDb()
    .prepare(
      `UPDATE messages SET
         to_addrs = @to_addrs,
         cc_addrs = @cc_addrs,
         bcc_addrs = @bcc_addrs,
         subject = @subject,
         body_text = @body_text,
         body_html = @body_html,
         in_reply_to = @in_reply_to,
         references_header = @references_header,
         draft_attachments = @draft_attachments,
         snippet = @snippet,
         date = @date
       WHERE id = @id AND folder_id IS NULL`
    )
    .run({
      to_addrs: patch.to_addrs,
      cc_addrs: patch.cc_addrs ?? null,
      bcc_addrs: patch.bcc_addrs ?? null,
      subject: patch.subject ?? null,
      body_text,
      body_html: patch.body_html ?? null,
      in_reply_to: patch.in_reply_to ?? null,
      references_header: patch.references_header ?? null,
      draft_attachments: patch.draft_attachments ?? null,
      snippet,
      date: Date.now(),
      id
    })
}

export function deleteDraft(id: number): void {
  getDb().prepare('DELETE FROM messages WHERE id = ? AND folder_id IS NULL').run(id)
}

