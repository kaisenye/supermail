import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { initDb, closeDb, getDb } from './db.js'
import {
  countOpenTasks,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  setTaskDone,
  updateTask
} from './tasks.js'

const ACC = 1

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'tasks-')), 't.db'))
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (?,'a@b.test')").run(ACC)
})

describe('tasks', () => {
  it('creates with a title and no due date', () => {
    const t = createTask({ account_id: ACC, title: 'Ship it' })
    expect(t.title).toBe('Ship it')
    expect(t.due_at).toBeNull()
    expect(t.done_at).toBeNull()
  })

  it('puts new tasks at the top', () => {
    createTask({ account_id: ACC, title: 'first' })
    createTask({ account_id: ACC, title: 'second' })
    expect(listTasks(ACC).map((t) => t.title)).toEqual(['second', 'first'])
  })

  it('patches only the fields given', () => {
    const t = createTask({ account_id: ACC, title: 'a', description: '<p>keep</p>' })
    const out = updateTask(t.id, { title: 'b' })
    expect(out?.title).toBe('b')
    expect(out?.description).toBe('<p>keep</p>')
  })

  it('clears a due date with an explicit null', () => {
    const t = createTask({ account_id: ACC, title: 'a', due_at: 123 })
    expect(updateTask(t.id, { due_at: null })?.due_at).toBeNull()
  })

  it('completes and reopens', () => {
    const t = createTask({ account_id: ACC, title: 'a' })
    expect(setTaskDone(t.id, true)?.done_at).toBeTypeOf('number')
    expect(setTaskDone(t.id, false)?.done_at).toBeNull()
  })

  it('sorts done tasks below open ones', () => {
    const a = createTask({ account_id: ACC, title: 'open' })
    const b = createTask({ account_id: ACC, title: 'closed' })
    setTaskDone(b.id, true)
    expect(listTasks(ACC).map((t) => t.title)).toEqual(['open', 'closed'])
    expect(a.id).toBeTypeOf('number')
  })

  it('excludes done tasks when asked', () => {
    const t = createTask({ account_id: ACC, title: 'x' })
    setTaskDone(t.id, true)
    expect(listTasks(ACC, false)).toHaveLength(0)
  })

  it('counts only open tasks', () => {
    createTask({ account_id: ACC, title: 'a' })
    const b = createTask({ account_id: ACC, title: 'b' })
    setTaskDone(b.id, true)
    expect(countOpenTasks(ACC)).toBe(1)
  })

  it('scopes to the account', () => {
    getDb().prepare("INSERT INTO accounts (id,email) VALUES (2,'c@d.test')").run()
    createTask({ account_id: ACC, title: 'mine' })
    createTask({ account_id: 2, title: 'theirs' })
    expect(listTasks(ACC).map((t) => t.title)).toEqual(['mine'])
    expect(countOpenTasks(2)).toBe(1)
  })

  it('deletes', () => {
    const t = createTask({ account_id: ACC, title: 'a' })
    deleteTask(t.id)
    expect(getTask(t.id)).toBeUndefined()
  })

  it('cascades when the account goes away', () => {
    createTask({ account_id: ACC, title: 'a' })
    getDb().prepare('DELETE FROM accounts WHERE id = ?').run(ACC)
    expect(listTasks(ACC)).toHaveLength(0)
    expect(Database).toBeTypeOf('function')
  })
})

describe('priority, search, sort and filter', () => {
  it('defaults to no priority', () => {
    expect(createTask({ account_id: ACC, title: 'a' }).priority).toBe(0)
  })

  it('stores and patches priority', () => {
    const t = createTask({ account_id: ACC, title: 'a', priority: 1 })
    expect(t.priority).toBe(1)
    expect(updateTask(t.id, { priority: 4 })?.priority).toBe(4)
  })

  it('sorts unset priority last, not first', () => {
    createTask({ account_id: ACC, title: 'none' })
    createTask({ account_id: ACC, title: 'low', priority: 4 })
    createTask({ account_id: ACC, title: 'urgent', priority: 1 })
    expect(listTasks(ACC, { sort: 'priority' }).map((t) => t.title)).toEqual([
      'urgent',
      'low',
      'none'
    ])
  })

  it('sorts undated tasks last when sorting by due date', () => {
    createTask({ account_id: ACC, title: 'undated' })
    createTask({ account_id: ACC, title: 'later', due_at: 2000 })
    createTask({ account_id: ACC, title: 'sooner', due_at: 1000 })
    expect(listTasks(ACC, { sort: 'due' }).map((t) => t.title)).toEqual([
      'sooner',
      'later',
      'undated'
    ])
  })

  it('searches titles case-insensitively', () => {
    createTask({ account_id: ACC, title: 'Send Poltra the price list' })
    createTask({ account_id: ACC, title: 'Book booth' })
    expect(listTasks(ACC, { search: 'poltra' }).map((t) => t.title)).toEqual([
      'Send Poltra the price list'
    ])
  })

  it('filters by priority without matching unset ones', () => {
    createTask({ account_id: ACC, title: 'none' })
    createTask({ account_id: ACC, title: 'urgent', priority: 1 })
    createTask({ account_id: ACC, title: 'low', priority: 4 })
    expect(listTasks(ACC, { minPriority: 2 }).map((t) => t.title)).toEqual(['urgent'])
  })

  it('filters by due date and excludes undated tasks', () => {
    createTask({ account_id: ACC, title: 'undated' })
    createTask({ account_id: ACC, title: 'soon', due_at: 500 })
    createTask({ account_id: ACC, title: 'far', due_at: 5000 })
    expect(listTasks(ACC, { dueBefore: 1000 }).map((t) => t.title)).toEqual(['soon'])
  })

  it('keeps done tasks below open ones regardless of sort', () => {
    const d = createTask({ account_id: ACC, title: 'done-urgent', priority: 1 })
    createTask({ account_id: ACC, title: 'open-low', priority: 4 })
    setTaskDone(d.id, true)
    expect(listTasks(ACC, { sort: 'priority' }).map((t) => t.title)).toEqual([
      'open-low',
      'done-urgent'
    ])
  })

  it('still accepts a bare boolean for includeDone', () => {
    const t = createTask({ account_id: ACC, title: 'x' })
    setTaskDone(t.id, true)
    expect(listTasks(ACC, false)).toHaveLength(0)
    expect(listTasks(ACC, true)).toHaveLength(1)
  })
})
