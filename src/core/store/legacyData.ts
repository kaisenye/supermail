import Database from 'better-sqlite3'
import { cpSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

/**
 * The app was called Supermail, and its data folder was named after it. On the
 * first launch as Sovo, copy the mail database and attachments across so
 * nothing is lost. A copy, not a move: an older build may still have the old
 * database open, and the old folder stays behind as a backup.
 *
 * Saved passwords do not come along. The OS keychain keys them to the app's
 * name, so each account asks for a new sign-in once; signing in with the same
 * address reattaches its mail, tasks and settings.
 *
 * Returns whether anything was copied.
 */
export function adoptLegacyData(oldDir: string, newDir: string, dbName: string): boolean {
  const oldDb = join(oldDir, 'supermail.db')
  const newDb = join(newDir, dbName)
  if (!existsSync(oldDb) || existsSync(newDb)) return false
  mkdirSync(newDir, { recursive: true })
  // VACUUM INTO writes one consistent file, WAL included, even while another
  // process is using the database.
  const db = new Database(oldDb, { readonly: true, fileMustExist: true })
  try {
    db.prepare('VACUUM INTO ?').run(newDb)
  } finally {
    db.close()
  }
  const attachments = join(oldDir, 'attachments')
  if (existsSync(attachments)) {
    cpSync(attachments, join(newDir, 'attachments'), { recursive: true, force: false, errorOnExist: false })
  }
  return true
}
