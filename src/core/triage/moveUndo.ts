import { getDb } from '../store/db.js'
import { restoreMessage } from '../store/repo.js'
import type { PlannedMove } from './movePlan.js'
import { restoreReminders, type ReminderSnapshot } from './reminders.js'

/**
 * Undo of a held move, as one transaction: either every row goes back (with
 * the fired reminders the move dropped) or nothing changes and the caller
 * lets the batch commit.
 *
 * A backfill during the hold can re-insert a held message into its source
 * folder as a new row, since the server still has it there. That copy sits on
 * the (account, folder, uid) the original is returning to, so it is deleted
 * first; otherwise the unique index would fail the restore partway through.
 */
export function rollbackMoves(jobs: PlannedMove[], reminders: ReminderSnapshot[] = []): void {
  const db = getDb()
  const dupe = db.prepare(
    'DELETE FROM messages WHERE account_id = ? AND folder_id = ? AND uid = ? AND id <> ?'
  )
  db.transaction(() => {
    for (const j of jobs) {
      dupe.run(j.accountId, j.fromFolderId, j.uid, j.id)
      restoreMessage(j.id, j.fromFolderId, j.uid)
    }
    if (reminders.length) restoreReminders(reminders)
  })()
}
