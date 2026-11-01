import type { Database } from 'better-sqlite3'
// Inlined at build time (?raw) — bundling flattens the output tree, so a
// runtime readFileSync of schema.sql cannot resolve in a packaged app.
import schemaSql from './schema.sql?raw'
import { assignRoles } from './folderRoles.js'

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
`),
  // v12: priority, Linear's scale. 0 = none so existing rows need no backfill;
  // 1..4 run urgent -> low, which is also their sort order.
  (db) =>
    db.exec(`
ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks (account_id, priority);
`),
  // v13: the threaded list groups a folder by thread and reads flags per row.
  // flags is in the index so that stays a single index scan; without it the
  // per-thread unread count costs a row fetch per message (~30ms vs ~0.2ms).
  (db) =>
    db.exec(`
CREATE INDEX IF NOT EXISTS idx_messages_thread_page
  ON messages (folder_id, thread_id, flags);
`),
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
  },

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
`),

  // v16: the mailbox UIDVALIDITY a move was captured under. A replay after the
  // server renumbered the mailbox would otherwise move an unrelated message.
  (db) => db.exec('ALTER TABLE move_jobs ADD COLUMN uidvalidity INTEGER'),

  // v17: how an account signs in. Existing rows are password IMAP accounts.
  (db) =>
    db.exec(`
ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'imap';
ALTER TABLE accounts ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'password';
`),

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
`),
  // list_dirty_au used INSERT OR IGNORE, but SQLite applies the outer
  // statement's conflict policy inside triggers: under upsertMessage's
  // ON CONFLICT DO UPDATE the IGNORE became ABORT, so any upsert that changed
  // a listed column while its thread was already dirty threw. NOT EXISTS never
  // conflicts, whatever the outer policy.
  (db) =>
    db.exec(`
DROP TRIGGER list_dirty_au;
CREATE TRIGGER list_dirty_au AFTER UPDATE ON messages
  WHEN old.folder_id IS NOT new.folder_id OR old.thread_id IS NOT new.thread_id
    OR old.flags IS NOT new.flags OR old.date IS NOT new.date
    OR old.from_addr IS NOT new.from_addr OR old.bulk IS NOT new.bulk
BEGIN
  INSERT INTO list_dirty
    SELECT old.account_id, COALESCE(old.thread_id, '#' || old.id)
     WHERE old.folder_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM list_dirty
                        WHERE account_id = old.account_id
                          AND thread_key = COALESCE(old.thread_id, '#' || old.id));
  INSERT INTO list_dirty
    SELECT new.account_id, COALESCE(new.thread_id, '#' || new.id)
     WHERE new.folder_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM list_dirty
                        WHERE account_id = new.account_id
                          AND thread_key = COALESCE(new.thread_id, '#' || new.id));
END;
`),
  // v20: Phase 3.
  // - outbox.cancel_on_reply: a scheduled reply is cancelled when someone
  //   answers the thread first (cancelOnReply.ts).
  // - folders.history_complete: the full-history worker has reached uid 1.
  // - snippets: plain-text templates with {variables}, inserted in compose.
  // - tasks_fts: the unified search page's Tasks scope. External content,
  //   kept aligned by triggers like messages_fts.
  // - idx_messages_from: the contact pane looks people up by sender on every
  //   thread open; without it each lookup scans the whole account.
  (db) =>
    db.exec(`
ALTER TABLE outbox ADD COLUMN cancel_on_reply INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_from ON messages (account_id, lower(from_addr));
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
`),

  // v21: Phase 4 AI (bring your own key). Local and opt-in.
  // - ai_classifications / reply_options: precomputed results keyed by
  //   account + Message-ID, like reminders, so a move or a rethread cannot
  //   orphan them.
  // - ai_jobs: the background queue (classify, replies). Finished rows are kept
  //   a week (status <> 'pending'), so a re-synced envelope is never queued twice.
  // - ai_usage: tokens and cost per day, provider, model and feature; the daily
  //   budget reads it.
  // - list_rows.ai_important / ai_category: the thread's newest verdict, so the
  //   Important / Other splits stay one indexed read.
  (db) =>
    db.exec(`
CREATE TABLE ai_classifications (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  important INTEGER NOT NULL,
  category TEXT NOT NULL,
  reason TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id)
) WITHOUT ROWID;

CREATE TABLE reply_options (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  options TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id)
) WITHOUT ROWID;

CREATE TABLE ai_jobs (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, message_id, kind)
);
CREATE INDEX idx_ai_jobs_due ON ai_jobs (status, next_at);

CREATE TABLE ai_usage (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  feature TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, model, feature)
) WITHOUT ROWID;

ALTER TABLE list_rows ADD COLUMN ai_important INTEGER;
ALTER TABLE list_rows ADD COLUMN ai_category TEXT;
`),
  // v22: custom AI labels, defined per inbox in Settings → AI. The fixed
  // categories (ai_classifications.category) stay as they are; these are only
  // the user's own, each with a description the classifier matches mail to.
  // - ai_labels: one row per label; name is unique per inbox, ignoring case.
  // - ai_message_labels: the labels a message got, keyed by account + Message-ID
  //   like ai_classifications. A message can carry several.
  (db) =>
    db.exec(`
CREATE TABLE ai_labels (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, name)
);

CREATE TABLE ai_message_labels (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  label_id INTEGER NOT NULL REFERENCES ai_labels(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, message_id, label_id)
) WITHOUT ROWID;

CREATE INDEX idx_ai_message_labels_label ON ai_message_labels (label_id);
`),
  // v23: the colours a Gmail user gave their labels. IMAP does not carry them;
  // the Gmail API's label list does, read with the account's OAuth token.
  // name is the label's full name, the same as its IMAP folder path.
  (db) =>
    db.exec(`
CREATE TABLE gmail_label_colors (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  bg TEXT NOT NULL,
  fg TEXT NOT NULL,
  PRIMARY KEY (account_id, name)
) WITHOUT ROWID;
`)
]

/** `target` stops early — tests use it to stage data at an older version. */
export function migrate(db: Database, target = migrations.length): number {
  const current = db.pragma('user_version', { simple: true }) as number

  for (let v = current; v < target; v++) {
    const run = db.transaction(() => {
      migrations[v](db)
      // pragma cannot be bound; v+1 is loop-derived, never user input
      db.pragma(`user_version = ${v + 1}`)
    })
    run()
  }

  return db.pragma('user_version', { simple: true }) as number
}
