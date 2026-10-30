import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fakeAi } from '../services/ai/fake.js'
import { AiError } from '../services/ai/types.js'
import { clearClassifications, getClassification, getReplyOptions } from '../store/ai.js'
import { closeDb, getDb, initDb } from '../store/db.js'
import { getSettings, setSetting, upsertMessage } from '../store/repo.js'
import { enqueueForMessage, runAiJobs } from './queue.js'

const NOW = 10_000_000_000
let uid = 0
function add(o: { from?: string; bulk?: number; date?: number } = {}): number {
  uid++
  return upsertMessage({
    account_id: 1,
    folder_id: 1,
    uid,
    message_id: `<q${uid}@t>`,
    thread_id: `q${uid}`,
    in_reply_to: null,
    from_addr: o.from ?? 'ann@x.test',
    from_name: null,
    to_addrs: JSON.stringify([{ address: 'me@x.test' }]),
    cc_addrs: '[]',
    subject: 'Hello',
    date: o.date ?? NOW - 1000,
    snippet: 'hi',
    body_text: 'Can we meet?',
    body_fetched: 1,
    flags: '[]',
    bulk: o.bulk ?? 0
  })
}
const jobs = () =>
  getDb().prepare('SELECT message_id, kind, status FROM ai_jobs ORDER BY id').all() as {
    message_id: string
    kind: string
    status: string
  }[]
const VERDICT = JSON.stringify({ important: true, category: 'work', reason: 'Asks to meet' })

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'queue-')), 't.db'))
  uid = 0
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
  getDb().prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox')").run()
})

describe('queueing background AI', () => {
  it('queues nothing while every background feature is off', () => {
    expect(enqueueForMessage(add(), NOW)).toEqual([])
    expect(jobs()).toEqual([])
  })

  it('queues fresh mail once, and never bulk, old or my own mail', () => {
    setSetting('ai_classify', '1')
    const a = add()
    expect(enqueueForMessage(a, NOW)).toEqual(['classify'])
    expect(enqueueForMessage(a, NOW)).toEqual([])
    expect(enqueueForMessage(add({ bulk: 1 }), NOW)).toEqual([])
    expect(enqueueForMessage(add({ date: 1 }), NOW)).toEqual([])
    expect(enqueueForMessage(add({ from: 'me@x.test' }), NOW)).toEqual([])
    expect(jobs()).toEqual([{ message_id: '<q1@t>', kind: 'classify', status: 'pending' }])
  })
})

describe('draining the queue', () => {
  beforeEach(() => setSetting('ai_classify', '1'))

  it('classifies, fetching the body first, and marks the job done', async () => {
    const a = add()
    enqueueForMessage(a, NOW)
    const fetched: number[] = []
    const r = await runAiJobs({ ai: fakeAi(() => VERDICT), ensureBody: async (_acc, id) => void fetched.push(id), now: () => NOW })
    expect(r).toEqual({ done: [{ accountId: 1, kind: 'classify' }], stopped: null })
    expect(fetched).toEqual([a])
    expect(getClassification(1, '<q1@t>')?.reason).toBe('Asks to meet')
    expect(jobs()[0].status).toBe('done')
  })

  it('skips jobs for a feature switched off since, and stops without a key', async () => {
    enqueueForMessage(add(), NOW)
    const off = await runAiJobs({ ai: fakeAi(() => VERDICT, { features: { classify: false } }), ensureBody: async () => {}, now: () => NOW })
    expect(off.done).toEqual([])
    expect(jobs()[0].status).toBe('skipped')
    enqueueForMessage(add(), NOW)
    const noKey = await runAiJobs({ ai: fakeAi(() => VERDICT, { hasKey: false }), ensureBody: async () => {}, now: () => NOW })
    expect(noKey.stopped).toBe('no-key')
    expect(jobs()[1].status).toBe('pending')
  })

  it('stops on the budget and leaves the job for tomorrow; retries other failures', async () => {
    enqueueForMessage(add(), NOW)
    const budget = fakeAi(() => {
      throw new AiError('budget', 'used up')
    })
    expect((await runAiJobs({ ai: budget, ensureBody: async () => {}, now: () => NOW })).stopped).toBe('budget')
    expect(jobs()[0].status).toBe('pending')
    const flaky = fakeAi(() => {
      throw new AiError('network', 'offline')
    })
    expect((await runAiJobs({ ai: flaky, ensureBody: async () => {}, now: () => NOW })).stopped).toBeNull()
    expect(getDb().prepare('SELECT attempts, error FROM ai_jobs').get()).toEqual({ attempts: 1, error: 'offline' })
  })

  it('saves nothing when the classifier is switched off while the provider answers', async () => {
    enqueueForMessage(add(), NOW)
    const base = fakeAi(() => {
      // What the settings handler does when the user unticks "Sort new mail".
      setSetting('ai_classify', '0')
      clearClassifications()
      return VERDICT
    })
    // Like the real service, the gate follows the stored toggle.
    const on = () => getSettings().ai_classify === '1'
    const ai = { ...base, status: () => ({ ...base.status(), features: { ...base.status().features, classify: on() } }) }
    const r = await runAiJobs({ ai, ensureBody: async () => {}, now: () => NOW })
    expect(r.done).toEqual([])
    expect(getClassification(1, '<q1@t>')).toBeNull()
    expect(jobs()[0].status).toBe('skipped')
  })

  it('classifies from the snippet when the body cannot be fetched', async () => {
    enqueueForMessage(add(), NOW)
    const r = await runAiJobs({
      ai: fakeAi(() => VERDICT),
      ensureBody: async () => {
        throw new Error('IMAP timeout')
      },
      now: () => NOW
    })
    expect(r).toEqual({ done: [{ accountId: 1, kind: 'classify' }], stopped: null })
    expect(getClassification(1, '<q1@t>')?.reason).toBe('Asks to meet')
    expect(jobs()[0].status).toBe('done')
  })

  it('precomputes replies for mail addressed to me, and skips robots', async () => {
    setSetting('ai_replies', '1')
    enqueueForMessage(add(), NOW)
    enqueueForMessage(add({ from: 'noreply@shop.test' }), NOW)
    const ai = fakeAi((f) => (f === 'replies' ? '{"options":["A","B","C"]}' : VERDICT))
    const r = await runAiJobs({ ai, ensureBody: async () => {}, now: () => NOW }, 10)
    expect(r.done).toEqual(
      expect.arrayContaining([
        { accountId: 1, kind: 'replies' },
        { accountId: 1, kind: 'classify' }
      ])
    )
    expect(getDb().prepare("SELECT message_id, status FROM ai_jobs WHERE kind = 'replies' ORDER BY id").all()).toEqual([
      { message_id: '<q1@t>', status: 'done' },
      { message_id: '<q2@t>', status: 'skipped' }
    ])
    expect(getReplyOptions(1, '<q1@t>')).toEqual(['A', 'B', 'C'])
  })

  it('expires jobs older than 48 hours instead of running them', async () => {
    enqueueForMessage(add(), NOW)
    const later = NOW + 49 * 3600_000
    const r = await runAiJobs({ ai: fakeAi(() => VERDICT), ensureBody: async () => {}, now: () => later })
    expect(r.done).toEqual([])
    expect(jobs()[0].status).toBe('expired')
  })
})
