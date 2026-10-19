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
