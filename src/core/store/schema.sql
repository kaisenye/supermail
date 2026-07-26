CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  imap_host TEXT, imap_port INTEGER,
  smtp_host TEXT, smtp_port INTEGER,
  auth_ref TEXT
);

CREATE TABLE folders (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT, path TEXT NOT NULL,
  uidvalidity INTEGER,
  last_uid INTEGER DEFAULT 0,
  UNIQUE (account_id, path)
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  uid INTEGER,
  message_id TEXT,
  thread_id TEXT,
  in_reply_to TEXT,
  from_addr TEXT, from_name TEXT,
  to_addrs TEXT,
  cc_addrs TEXT,
  subject TEXT,
  date INTEGER,
  snippet TEXT,
  body_text TEXT,
  body_html TEXT,
  flags TEXT,
  has_attachments INTEGER DEFAULT 0,
  body_fetched INTEGER DEFAULT 0,
  -- stage-2 / AI columns: nullable, unpopulated in stage 1
  summary TEXT,
  ai_labels TEXT,
  embedding_id INTEGER,
  entities TEXT,
  workflow_state TEXT
);

-- drafts carry folder_id IS NULL, so uid dedupe only applies to synced mail
CREATE UNIQUE INDEX idx_messages_uid ON messages (account_id, folder_id, uid)
  WHERE folder_id IS NOT NULL;
CREATE INDEX idx_messages_list ON messages (folder_id, date DESC);
CREATE INDEX idx_messages_thread ON messages (thread_id);
CREATE INDEX idx_messages_msgid ON messages (message_id);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT, mime TEXT, size INTEGER,
  part_id TEXT,
  storage_path TEXT
);
CREATE INDEX idx_attachments_msg ON attachments (message_id);

CREATE TABLE labels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE, color TEXT
);

CREATE TABLE message_labels (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, label_id)
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, from_name, from_addr, body_text,
  content='messages', content_rowid='id'
);

-- external-content FTS does not self-sync; these triggers keep it aligned
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, subject, from_name, from_addr, body_text)
  VALUES (new.id, new.subject, new.from_name, new.from_addr, new.body_text);
END;

CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, subject, from_name, from_addr, body_text)
  VALUES ('delete', old.id, old.subject, old.from_name, old.from_addr, old.body_text);
END;

CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, subject, from_name, from_addr, body_text)
  VALUES ('delete', old.id, old.subject, old.from_name, old.from_addr, old.body_text);
  INSERT INTO messages_fts (rowid, subject, from_name, from_addr, body_text)
  VALUES (new.id, new.subject, new.from_name, new.from_addr, new.body_text);
END;

-- stage-2 stub, empty in stage 1
CREATE TABLE embeddings (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  vec BLOB, model TEXT
);
