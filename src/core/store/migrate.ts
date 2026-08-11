import type { Database } from 'better-sqlite3'
// Inlined at build time (?raw) — bundling flattens the output tree, so a
// runtime readFileSync of schema.sql cannot resolve in a packaged app.
import schemaSql from './schema.sql?raw'

type Migration = (db: Database) => void

// Append only. Index + 1 becomes user_version. Never reorder or edit a shipped entry.
const migrations: Migration[] = [
  (db) => db.exec(schemaSql),
  // v2: outbox for compose / schedule / undo-send
  (db) =>
    db.exec(`
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  to_addrs TEXT NOT NULL,
  cc_addrs TEXT,
  bcc_addrs TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  send_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox (status, send_at);
`),
  // v3: outbound attachments, stored as a JSON array of picked file paths
  (db) => db.exec('ALTER TABLE outbox ADD COLUMN attachments TEXT'),
  // v4: fields a draft must keep so reopening one does not silently send
  // without its bcc, thread references, or attachments
  (db) =>
    db.exec(`
ALTER TABLE messages ADD COLUMN bcc_addrs TEXT;
ALTER TABLE messages ADD COLUMN references_header TEXT;
ALTER TABLE messages ADD COLUMN draft_attachments TEXT;
`),
  // v5: user preferences (signature, theme) as simple key/value
  (db) =>
    db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`),
  // v6: trigram index for typo-tolerant search. Separate from messages_fts
  // because a trigram tokenizer cannot serve normal word queries well — the
  // two indexes answer different questions.
  (db) =>
    db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS messages_trgm USING fts5(
  subject, from_name, from_addr, body_text,
  content='messages', content_rowid='id',
  tokenize='trigram'
);

INSERT INTO messages_trgm (rowid, subject, from_name, from_addr, body_text)
  SELECT id, subject, from_name, from_addr, body_text FROM messages;

CREATE TRIGGER IF NOT EXISTS messages_trgm_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_trgm (rowid, subject, from_name, from_addr, body_text)
  VALUES (new.id, new.subject, new.from_name, new.from_addr, new.body_text);
END;

CREATE TRIGGER IF NOT EXISTS messages_trgm_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_trgm (messages_trgm, rowid, subject, from_name, from_addr, body_text)
  VALUES ('delete', old.id, old.subject, old.from_name, old.from_addr, old.body_text);
END;

CREATE TRIGGER IF NOT EXISTS messages_trgm_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_trgm (messages_trgm, rowid, subject, from_name, from_addr, body_text)
  VALUES ('delete', old.id, old.subject, old.from_name, old.from_addr, old.body_text);
  INSERT INTO messages_trgm (rowid, subject, from_name, from_addr, body_text)
  VALUES (new.id, new.subject, new.from_name, new.from_addr, new.body_text);
END;
`),
  // v7: inline (cid:) parts are now stored so the body can render them.
  // Existing rows predate this; a re-fetch of those bodies fills them in.
  (db) => db.exec('ALTER TABLE attachments ADD COLUMN inline INTEGER DEFAULT 0'),
  // v8: `<>` is not a message id — Zimbra emits an empty leading reference, and
  // taking references[0] blindly made it the thread id for unrelated mail.
  // Null it out so those rows fall back to their own id (a thread of one) until
  // the rethread pass gives them the real root.
  (db) =>
    db.exec(
      `UPDATE messages SET thread_id = message_id
        WHERE thread_id IN ('<>', '<', '>', '');
       UPDATE messages SET in_reply_to = NULL
        WHERE in_reply_to IN ('<>', '<', '>', '');`
    ),
  // v9: snooze. wake_at is the local source of truth — the server has no
  // concept of it, so the row remembers where to return the message to.
  (db) =>
    db.exec(
      `ALTER TABLE messages ADD COLUMN wake_at INTEGER;
       ALTER TABLE messages ADD COLUMN snooze_from TEXT;
       CREATE INDEX idx_messages_wake ON messages (wake_at) WHERE wake_at IS NOT NULL;`
    ),
  // v10: the uid MOVE assigned in Snoozed. Exmail's SEARCH HEADER cannot find
  // a message by Message-ID, so this is the only way back.
  (db) => db.exec('ALTER TABLE messages ADD COLUMN snooze_uid INTEGER'),
  // v11: tasks. Local only — nothing here syncs to IMAP, so no account
  // scoping beyond the owning account for multi-account separation.
  (db) =>
    db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  due_at INTEGER,
  done_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sort_order REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks (account_id, done_at, sort_order);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks (account_id, due_at) WHERE due_at IS NOT NULL;
`)
]

export function migrate(db: Database): number {
  const current = db.pragma('user_version', { simple: true }) as number

  for (let v = current; v < migrations.length; v++) {
    const run = db.transaction(() => {
      migrations[v](db)
      // pragma cannot be bound; v+1 is loop-derived, never user input
      db.pragma(`user_version = ${v + 1}`)
    })
    run()
  }

  return db.pragma('user_version', { simple: true }) as number
}
