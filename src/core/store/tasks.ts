import { getDb } from './db.js'

/** Linear's scale: 0 none, 1 urgent … 4 low. Numeric so it sorts directly. */
export type Priority = 0 | 1 | 2 | 3 | 4

export interface Task {
  id: number
  account_id: number
  title: string
  /** Sanitised HTML — links are the only markup that matters here. */
  description: string | null
  due_at: number | null
  done_at: number | null
  priority: Priority
  created_at: number
  updated_at: number
  sort_order: number
}

export interface NewTask {
  account_id: number
  title: string
  description?: string | null
  due_at?: number | null
  priority?: Priority
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
      `INSERT INTO tasks
         (account_id, title, description, due_at, priority, created_at, updated_at, sort_order)
       VALUES
         (@account_id, @title, @description, @due_at, @priority, @created_at, @updated_at, @sort_order)
       RETURNING *`
    )
    .get({
      account_id: t.account_id,
      title: t.title,
      description: t.description ?? null,
      due_at: t.due_at ?? null,
      priority: t.priority ?? 0,
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
  priority?: Priority
  sort_order?: number
}

/** Only the fields present in the patch are written. */
export function updateTask(id: number, patch: TaskPatch): Task | undefined {
  const sets: string[] = []
  const params: Record<string, unknown> = { id, updated_at: Date.now() }
  for (const key of ['title', 'description', 'due_at', 'priority', 'sort_order'] as const) {
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

export type TaskSort = 'manual' | 'due' | 'priority'

export interface TaskQuery {
  includeDone?: boolean
  /** Substring match on title; description is HTML so it is not searched. */
  search?: string
  sort?: TaskSort
  /** Only tasks at or above this urgency (1 urgent .. 4 low). */
  minPriority?: number
  /** Only tasks due on or before this instant. Undated ones are excluded. */
  dueBefore?: number
}

/**
 * Open tasks first, then completed ones most-recent first. Done work stays
 * visible but out of the way rather than vanishing.
 *
 * Priority sorts with 0 ("none") last rather than first — numerically it is
 * lowest, but it means "unset", not "most urgent".
 */
export function listTasks(accountId: number, q: TaskQuery | boolean = {}): Task[] {
  // Long-standing callers pass a bare boolean for includeDone.
  const opts: TaskQuery = typeof q === 'boolean' ? { includeDone: q } : q
  const where = ['account_id = @account_id']
  const params: Record<string, unknown> = { account_id: accountId }

  if (opts.includeDone === false) where.push('done_at IS NULL')
  if (opts.search?.trim()) {
    where.push('lower(title) LIKE @search')
    params.search = `%${opts.search.trim().toLowerCase()}%`
  }
  if (opts.minPriority) {
    // 0 means unset, so it can never satisfy a priority filter.
    where.push('priority > 0 AND priority <= @minPriority')
    params.minPriority = opts.minPriority
  }
  if (opts.dueBefore) {
    where.push('due_at IS NOT NULL AND due_at <= @dueBefore')
    params.dueBefore = opts.dueBefore
  }

  const order =
    opts.sort === 'due'
      ? // Undated tasks sink to the bottom rather than sorting as "earliest".
        'due_at IS NULL, due_at, sort_order'
      : opts.sort === 'priority'
        ? 'priority = 0, priority, sort_order'
        : 'sort_order'

  return getDb()
    .prepare(
      `SELECT * FROM tasks WHERE ${where.join(' AND ')}
       ORDER BY done_at IS NOT NULL, ${order}, done_at DESC`
    )
    .all(params) as Task[]
}

/** Drives the sidebar badge: open tasks only. */
export function countOpenTasks(accountId: number): number {
  return (
    getDb()
      .prepare('SELECT count(*) c FROM tasks WHERE account_id = ? AND done_at IS NULL')
      .get(accountId) as { c: number }
  ).c
}
