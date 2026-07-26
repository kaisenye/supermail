import { getDb } from './db.js'
import type {
  Account,
  Folder,
  Message,
  MessageListRow,
  UpsertMessageInput
} from './types.js'

const LIST_COLS =
  'id, thread_id, from_addr, from_name, subject, date, snippet, flags, has_attachments'

// ---- accounts ----

export function upsertAccount(a: Omit<Account, 'id'>): Account {
  const db = getDb()
  db.prepare(
    `INSERT INTO accounts (email, imap_host, imap_port, smtp_host, smtp_port, auth_ref)
     VALUES (@email, @imap_host, @imap_port, @smtp_host, @smtp_port, @auth_ref)
     ON CONFLICT(email) DO UPDATE SET
       imap_host = excluded.imap_host, imap_port = excluded.imap_port,
       smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port,
       auth_ref  = excluded.auth_ref`
  ).run(a)
  return db.prepare('SELECT * FROM accounts WHERE email = ?').get(a.email) as Account
}

export function listAccounts(): Account[] {
  return getDb().prepare('SELECT * FROM accounts ORDER BY id').all() as Account[]
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

export function listFolders(accountId: number): Folder[] {
  return getDb()
    .prepare('SELECT * FROM folders WHERE account_id = ? ORDER BY path')
    .all(accountId) as Folder[]
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

export function upsertMessage(m: UpsertMessageInput): number {
  const row = {
    body_text: null,
    body_html: null,
    has_attachments: 0,
    body_fetched: 0,
    entities: null,
    // null = "leave stored flags alone"; only IMAP passes a real value.
    flags: null,
    ...m
  }
  const info = getDb()
    .prepare(
      `INSERT INTO messages (
         account_id, folder_id, uid, message_id, thread_id, in_reply_to,
         from_addr, from_name, to_addrs, cc_addrs, subject, date, snippet,
         body_text, body_html, flags, has_attachments, body_fetched, entities
       ) VALUES (
         @account_id, @folder_id, @uid, @message_id, @thread_id, @in_reply_to,
         @from_addr, @from_name, @to_addrs, @cc_addrs, @subject, @date, @snippet,
         @body_text, @body_html, @flags, @has_attachments, @body_fetched, @entities
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
         entities     = COALESCE(excluded.entities, messages.entities)
       RETURNING id`
    )
    .get(row) as { id: number }
  return info.id
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

/** Soft-remove from current folder view after archive/trash (local delete). */
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

export function listInbox(
  folderId: number,
  limit = 100,
  offset = 0
): MessageListRow[] {
  return getDb()
    .prepare(
      `SELECT ${LIST_COLS} FROM messages
       WHERE folder_id = ? ORDER BY date DESC LIMIT ? OFFSET ?`
    )
    .all(folderId, limit, offset) as MessageListRow[]
}

export function getThread(threadId: string): Message[] {
  return getDb()
    .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC')
    .all(threadId) as Message[]
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
    .prepare('SELECT id, filename, mime, size FROM attachments WHERE message_id = ?')
    .all(messageId) as { id: number; filename: string | null; mime: string | null; size: number | null }[]
}

export function searchMessages(query: string, limit = 100): MessageListRow[] {
  const q = toFtsQuery(query)
  if (!q) return []
  return getDb()
    .prepare(
      `SELECT ${LIST_COLS.split(', ')
        .map((c) => `m.${c}`)
        .join(', ')}
       FROM messages_fts f JOIN messages m ON m.id = f.rowid
       WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`
    )
    .all(q, limit) as MessageListRow[]
}

// ---- drafts (folder_id IS NULL) ----

export interface DraftInput {
  account_id: number
  to_addrs: string
  cc_addrs?: string | null
  subject?: string | null
  body_text?: string | null
  body_html?: string | null
  in_reply_to?: string | null
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
         from_addr, from_name, to_addrs, cc_addrs, subject, date, snippet,
         body_text, body_html, flags, has_attachments, body_fetched
       ) VALUES (
         @account_id, NULL, NULL, NULL, NULL, @in_reply_to,
         @from_addr, @from_name, @to_addrs, @cc_addrs, @subject, @date, @snippet,
         @body_text, @body_html, '[]', 0, 1
       )`
    )
    .run({
      account_id: input.account_id,
      in_reply_to: input.in_reply_to ?? null,
      from_addr: input.from_addr,
      from_name: input.from_name ?? null,
      to_addrs: input.to_addrs,
      cc_addrs: input.cc_addrs ?? null,
      subject: input.subject ?? null,
      date: now,
      snippet,
      body_text: input.body_text ?? null,
      body_html: input.body_html ?? null
    })
  return Number(info.lastInsertRowid)
}

export function updateDraft(
  id: number,
  patch: {
    to_addrs: string
    cc_addrs?: string | null
    subject?: string | null
    body_text?: string | null
    body_html?: string | null
    in_reply_to?: string | null
  }
): void {
  const cur = getMessage(id)
  if (!cur || cur.folder_id != null) return
  const body_text = patch.body_text ?? null
  const snippet = (body_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
  getDb()
    .prepare(
      `UPDATE messages SET
         to_addrs = ?,
         cc_addrs = ?,
         subject = ?,
         body_text = ?,
         body_html = ?,
         in_reply_to = ?,
         snippet = ?,
         date = ?
       WHERE id = ? AND folder_id IS NULL`
    )
    .run(
      patch.to_addrs,
      patch.cc_addrs ?? null,
      patch.subject ?? null,
      body_text,
      patch.body_html ?? null,
      patch.in_reply_to ?? null,
      snippet,
      Date.now(),
      id
    )
}

export function deleteDraft(id: number): void {
  getDb().prepare('DELETE FROM messages WHERE id = ? AND folder_id IS NULL').run(id)
}

/**
 * FTS5 treats punctuation as syntax, so raw user input throws on typing
 * things like "re:" or "a@b.com". Quote each token and prefix-match the last.
 */
function toFtsQuery(input: string): string {
  const tokens = input.match(/[\p{L}\p{N}]+/gu)
  if (!tokens?.length) return ''
  return tokens.map((t, i) => `"${t}"${i === tokens.length - 1 ? '*' : ''}`).join(' ')
}
