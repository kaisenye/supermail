import { getDb } from './db.js'

export interface Task {
  id: number
  account_id: number
  title: string
  /** Sanitised HTML — links are the only markup that matters here. */
  description: string | null
  due_at: number | null
  done_at: number | null
  created_at: number
  updated_at: number
  sort_order: number
}

export interface NewTask {
  account_id: number
  title: string
  description?: string | null
  due_at?: number | null
}

/**
 * Fractional ordering: a task dropped between two others takes the midpoint,
 * so a reorder writes one row rather than renumbering the list.
 */
function nextOrder(accountId: number): number {
  const row = getDb()
    .prepare('SELECT MIN(sort_order) m FROM tasks WHERE account_id = ? AND done_at IS NULL')
    .get(accountId) as { m: number | null }
  return (row.m ?? 0) - 1
}

export function createTask(t: NewTask): Task {
  const now = Date.now()
  const info = getDb()
    .prepare(
      `INSERT INTO tasks (account_id, title, description, due_at, created_at, updated_at, sort_order)
       VALUES (@account_id, @title, @description, @due_at, @created_at, @updated_at, @sort_order)
       RETURNING *`
    )
    .get({
      account_id: t.account_id,
      title: t.title,
      description: t.description ?? null,
      due_at: t.due_at ?? null,
      created_at: now,
      updated_at: now,
      // New tasks land at the top, where a just-captured thought belongs.
      sort_order: nextOrder(t.account_id)
    }) as Task
  return info
}

export interface TaskPatch {
  title?: string
  description?: string | null
  due_at?: number | null
  sort_order?: number
}

/** Only the fields present in the patch are written. */
export function updateTask(id: number, patch: TaskPatch): Task | undefined {
  const sets: string[] = []
  const params: Record<string, unknown> = { id, updated_at: Date.now() }
  for (const key of ['title', 'description', 'due_at', 'sort_order'] as const) {
    if (key in patch) {
      sets.push(`${key} = @${key}`)
      params[key] = patch[key]
    }
  }
  if (!sets.length) return getTask(id)
  return getDb()
    .prepare(
      `UPDATE tasks SET ${sets.join(', ')}, updated_at = @updated_at
       WHERE id = @id RETURNING *`
    )
    .get(params) as Task | undefined
}

/** Returns the new state so the caller need not re-read. */
export function setTaskDone(id: number, done: boolean): Task | undefined {
  return getDb()
    .prepare('UPDATE tasks SET done_at = ?, updated_at = ? WHERE id = ? RETURNING *')
    .get(done ? Date.now() : null, Date.now(), id) as Task | undefined
}

export function deleteTask(id: number): void {
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id)
}

export function getTask(id: number): Task | undefined {
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined
}

/**
 * Open tasks in manual order, then completed ones most-recent first. Done work
 * stays visible but out of the way rather than vanishing.
 */
export function listTasks(accountId: number, includeDone = true): Task[] {
  const sql = includeDone
    ? `SELECT * FROM tasks WHERE account_id = ?
       ORDER BY done_at IS NOT NULL, sort_order, done_at DESC`
    : `SELECT * FROM tasks WHERE account_id = ? AND done_at IS NULL
       ORDER BY sort_order`
  return getDb().prepare(sql).all(accountId) as Task[]
}

/** Drives the sidebar badge: open tasks only. */
export function countOpenTasks(accountId: number): number {
  return (
    getDb()
      .prepare('SELECT count(*) c FROM tasks WHERE account_id = ? AND done_at IS NULL')
      .get(accountId) as { c: number }
  ).c
}
