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
