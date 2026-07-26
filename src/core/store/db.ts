import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import { migrate } from './migrate.js'

let db: Db | null = null

export function openDb(path: string): Db {
  const conn = new Database(path)
  conn.pragma('journal_mode = WAL')
  conn.pragma('synchronous = NORMAL')
  conn.pragma('foreign_keys = ON')
  migrate(conn)
  return conn
}

/** Process-wide handle. initDb must run before any repo call. */
export function initDb(path: string): Db {
  if (!db) db = openDb(path)
  return db
}

export function getDb(): Db {
  if (!db) throw new Error('db not initialized — call initDb first')
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}
