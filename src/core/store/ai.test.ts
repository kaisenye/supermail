import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import {
  clearClassifications,
  dueAiJobs,
  enqueueAiJob,
  expireAiJobs,
  finishAiJob,
  getClassification,
  getReplyOptions,
  pruneAiJobs,
  recordAiUsage,
  retryAiJob,
  saveClassification,
  saveReplyOptions,
  setSummary,
  spentMicros
} from './ai.js'
import { getMessage, upsertMessage } from './repo.js'

let rowId: number

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'aistore-')), 't.db'))
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
  db.prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox')").run()
  rowId = upsertMessage({
    account_id: 1,
    folder_id: 1,
    uid: 1,
    message_id: '<a@t>',
    thread_id: 't1',
    in_reply_to: null,
    from_addr: 'x@y.test',
    from_name: null,
    to_addrs: '[]',
    cc_addrs: '[]',
    subject: 'Hi',
    date: 10,
    snippet: null,
    flags: '[]'
  })
  db.prepare('DELETE FROM list_dirty').run()
})

const dirty = () =>
  (getDb().prepare('SELECT account_id, thread_key FROM list_dirty').all() as {
    account_id: number
    thread_key: string
  }[]).map((r) => `${r.account_id}:${r.thread_key}`)

describe('classifications', () => {
  it('stores a verdict, overwrites it, and marks the thread dirty', () => {
    saveClassification(1, '<a@t>', { important: true, category: 'work', reason: 'Asks a question', model: 'm1' })
    expect(dirty()).toEqual(['1:t1'])
    saveClassification(1, '<a@t>', { important: false, category: 'newsletter', reason: 'Digest', model: 'm2' })
    expect(getClassification(1, '<a@t>')).toEqual({
      important: false,
      category: 'newsletter',
      reason: 'Digest',
      model: 'm2'
    })
    expect(getClassification(1, '<missing@t>')).toBeNull()
  })

  it('clears every verdict and marks their threads dirty', () => {
    saveClassification(1, '<a@t>', { important: true, category: 'work', reason: 'r', model: 'm' })
    getDb().prepare('DELETE FROM list_dirty').run()
    expect(clearClassifications()).toBe(1)
    expect(getClassification(1, '<a@t>')).toBeNull()
    expect(dirty()).toEqual(['1:t1'])
  })
})

describe('reply options and summaries', () => {
  it('round-trips three options and ignores a corrupt row', () => {
    saveReplyOptions(1, '<a@t>', ['Yes', 'No', 'Maybe'], 'm')
    expect(getReplyOptions(1, '<a@t>')).toEqual(['Yes', 'No', 'Maybe'])
    getDb().prepare("UPDATE reply_options SET options = 'not json'").run()
    expect(getReplyOptions(1, '<a@t>')).toBeNull()
  })

  it('writes the summary on the message row', () => {
    setSummary(rowId, 'Bob asks for the deck by Friday.')
    expect(getMessage(rowId)?.summary).toBe('Bob asks for the deck by Friday.')
  })
})

describe('the job queue', () => {
  it('queues a message once per kind and hands out the newest first', () => {
    expect(enqueueAiJob(1, '<a@t>', 'classify', 100)).toBe(true)
    expect(enqueueAiJob(1, '<a@t>', 'classify', 200)).toBe(false)
    expect(enqueueAiJob(1, '<b@t>', 'classify', 300)).toBe(true)
    expect(dueAiJobs(1000, 10).map((j) => j.message_id)).toEqual(['<b@t>', '<a@t>'])
  })

  it('never re-queues a finished job', () => {
    enqueueAiJob(1, '<a@t>', 'replies', 100)
    finishAiJob(dueAiJobs(1000, 1)[0].id, 'done')
    expect(enqueueAiJob(1, '<a@t>', 'replies', 200)).toBe(false)
    expect(dueAiJobs(1000, 10)).toEqual([])
  })

  it('backs off a failing job and gives up after three attempts', () => {
    enqueueAiJob(1, '<a@t>', 'classify', 0)
    const id = dueAiJobs(0, 1)[0].id
    retryAiJob(id, 'boom', 1000)
    expect(dueAiJobs(1000 + 59_999, 10)).toEqual([])
    expect(dueAiJobs(1000 + 60_000, 10).map((j) => j.attempts)).toEqual([1])
    retryAiJob(id, 'boom', 2000)
    retryAiJob(id, 'boom', 3000)
    const row = getDb().prepare('SELECT status, error FROM ai_jobs WHERE id = ?').get(id)
    expect(row).toEqual({ status: 'failed', error: 'boom' })
  })

  it('expires stale pending jobs and prunes old finished ones', () => {
    enqueueAiJob(1, '<a@t>', 'classify', 100)
    enqueueAiJob(1, '<b@t>', 'classify', 5000)
    expect(expireAiJobs(1000)).toBe(1)
    expect(dueAiJobs(10_000, 10).map((j) => j.message_id)).toEqual(['<b@t>'])
    expect(pruneAiJobs(1000)).toBe(1)
    expect((getDb().prepare('SELECT count(*) AS c FROM ai_jobs').get() as { c: number }).c).toBe(1)
  })
})

describe('usage', () => {
  it('adds up cost per day', () => {
    const u = { provider: 'anthropic', model: 'claude-sonnet-5-5', feature: 'summary', inputTokens: 100, outputTokens: 10 }
    recordAiUsage({ ...u, day: '2026-10-30', costMicros: 300 })
    recordAiUsage({ ...u, day: '2026-10-30', costMicros: 200 })
    recordAiUsage({ ...u, day: '2026-10-31', costMicros: 50 })
    expect(spentMicros('2026-10-30')).toBe(500)
    expect(spentMicros('2026-10-31')).toBe(50)
    expect(spentMicros('2026-11-01')).toBe(0)
    const row = getDb().prepare("SELECT calls, input_tokens FROM ai_usage WHERE day = '2026-10-30'").get()
    expect(row).toEqual({ calls: 2, input_tokens: 200 })
  })
})
