import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fakeAi } from '../services/ai/fake.js'
import { closeDb, getDb, initDb } from '../store/db.js'
import { upsertMessage } from '../store/repo.js'
import { threadInsights } from './insights.js'
import { SUMMARY_MIN_CHARS, summarizable, summarizeThread, summarizeThreadOnce } from './summary.js'

let uid = 0
function add(thread: string, date: number, body: string, fetched = 1): number {
  uid++
  return upsertMessage({
    account_id: 1,
    folder_id: 1,
    uid,
    message_id: `<s${uid}@t>`,
    thread_id: thread,
    in_reply_to: null,
    from_addr: 'bob@x.test',
    from_name: 'Bob',
    to_addrs: '[]',
    cc_addrs: '[]',
    subject: 'Deck',
    date,
    snippet: body.slice(0, 40),
    body_text: fetched ? body : null,
    body_fetched: fetched,
    flags: '[]'
  })
}

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'summary-')), 't.db'))
  uid = 0
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
  getDb().prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox')").run()
})

describe('summaries', () => {
  it('summarizes once, caches on the newest message, and goes stale on a new reply', async () => {
    add('t', 1000, 'Can you send the deck?')
    add('t', 2000, 'Friday is fine.')
    const ai = fakeAi(() => '"Bob wants the deck; Friday works."\nextra line')
    const deps = { ai, ensureBodies: async () => {} }
    expect(await summarizeThread(deps, 1, 't')).toEqual({ summary: 'Bob wants the deck; Friday works.', cached: false })
    expect(await summarizeThread(deps, 1, 't')).toEqual({ summary: 'Bob wants the deck; Friday works.', cached: true })
    expect(ai.calls).toHaveLength(1)
    expect(ai.calls[0].req.prompt).toContain('Subject: Deck')
    expect(threadInsights(1, 't', ai.status().features).summary).toBe('Bob wants the deck; Friday works.')
    add('t', 3000, 'Actually, Monday.')
    expect(threadInsights(1, 't', ai.status().features).summary).toBeNull()
    await summarizeThread(deps, 1, 't')
    expect(ai.calls).toHaveLength(2)
  })

  it('skips a single short message without calling the model', async () => {
    add('one', 1000, 'Thanks!')
    const ai = fakeAi(() => 'x')
    expect(await summarizeThread({ ai, ensureBodies: async () => {} }, 1, 'one')).toEqual({ summary: null, cached: false })
    expect(ai.calls).toHaveLength(0)
  })

  it('tells the thread view up front whether a summary would run', () => {
    const NOTHING = { summary: null, summarizable: false, classification: null, replyTarget: null, replies: null }
    const features = fakeAi(() => 'x').status().features
    add('short', 1000, 'Thanks!')
    expect(threadInsights(1, 'short', features)).toEqual(NOTHING)
    add('long', 1000, 'word '.repeat(SUMMARY_MIN_CHARS / 4))
    expect(threadInsights(1, 'long', features).summarizable).toBe(true)
    add('pair', 1000, 'Can you send the deck?')
    add('pair', 2000, 'Yes.')
    expect(threadInsights(1, 'pair', features).summarizable).toBe(true)
    // Body not stored yet: reads as its snippet, so short until MessageBody fetches it.
    add('unfetched', 1000, 'word '.repeat(SUMMARY_MIN_CHARS / 4), 0)
    expect(threadInsights(1, 'unfetched', features).summarizable).toBe(false)
    // Summaries off: nothing runs, so nothing is summarizable.
    const off = fakeAi(() => 'x', { features: { summary: false } }).status().features
    expect(threadInsights(1, 'pair', off)).toEqual(NOTHING)
  })

  it('uses one rule for the store read and the run', async () => {
    const long = { body_text: 'x'.repeat(SUMMARY_MIN_CHARS), body_html: null, snippet: null }
    const short = { body_text: 'x'.repeat(SUMMARY_MIN_CHARS - 1), body_html: null, snippet: null }
    expect(summarizable([])).toBe(false)
    expect(summarizable([short])).toBe(false)
    expect(summarizable([long])).toBe(true)
    expect(summarizable([short, short])).toBe(true)
    add('edge', 1000, 'x'.repeat(SUMMARY_MIN_CHARS))
    const ai = fakeAi(() => 'A line.')
    expect(await summarizeThread({ ai, ensureBodies: async () => {} }, 1, 'edge')).toEqual({
      summary: 'A line.',
      cached: false
    })
  })

  it('fetches missing bodies first', async () => {
    add('t2', 1000, 'first body', 0)
    add('t2', 2000, 'second body', 1)
    const asked: number[][] = []
    const ai = fakeAi(() => 'Summary.')
    await summarizeThread({ ai, ensureBodies: async (_a, ids) => void asked.push(ids) }, 1, 't2')
    expect(asked).toEqual([[1]])
  })

  it('runs one provider call when the same thread is asked for twice at once', async () => {
    add('t3', 1000, 'Can you send the deck?')
    add('t3', 2000, 'Friday is fine.')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const ai = fakeAi(() => 'Deck by Friday.')
    const deps = { ai, ensureBodies: async () => {} }
    const slow = { ...deps, ai: { ...ai, run: async (...a: Parameters<typeof ai.run>) => (await gate, ai.run(...a)) } }
    const first = summarizeThreadOnce(slow, 1, 't3')
    const second = summarizeThreadOnce(slow, 1, 't3')
    release()
    expect(await first).toEqual({ summary: 'Deck by Friday.', cached: false })
    expect(await second).toEqual({ summary: 'Deck by Friday.', cached: false })
    expect(ai.calls).toHaveLength(1)
    // Done: the next request reads the cache, it does not join a stale promise.
    expect(await summarizeThreadOnce(deps, 1, 't3')).toEqual({ summary: 'Deck by Friday.', cached: true })
    expect(ai.calls).toHaveLength(1)
  })

  it('frees the slot after a failed run, so a retry calls again', async () => {
    add('t4', 1000, 'Can you send the deck?')
    add('t4', 2000, 'Friday is fine.')
    let n = 0
    const failing = fakeAi(() => {
      n++
      throw new Error('boom')
    })
    const deps = { ai: failing, ensureBodies: async () => {} }
    await expect(summarizeThreadOnce(deps, 1, 't4')).rejects.toThrow('boom')
    await expect(summarizeThreadOnce(deps, 1, 't4')).rejects.toThrow('boom')
    expect(n).toBe(2)
  })

  it('refuses a cached line once Summaries is off or the key is gone', async () => {
    add('t5', 1000, 'Can you send the deck?')
    add('t5', 2000, 'Friday is fine.')
    const on = fakeAi(() => 'Deck by Friday.')
    await summarizeThread({ ai: on, ensureBodies: async () => {} }, 1, 't5')
    expect(threadInsights(1, 't5', on.status().features).summary).toBe('Deck by Friday.')

    const off = fakeAi(() => 'x', { features: { summary: false } })
    await expect(summarizeThread({ ai: off, ensureBodies: async () => {} }, 1, 't5')).rejects.toMatchObject({
      code: 'disabled',
      message: 'Summaries is off in Settings → AI'
    })
    expect(threadInsights(1, 't5', off.status().features).summary).toBeNull()

    const noKey = fakeAi(() => 'x', { hasKey: false })
    await expect(summarizeThread({ ai: noKey, ensureBodies: async () => {} }, 1, 't5')).rejects.toMatchObject({
      code: 'no-key',
      message: 'Add your Anthropic key in Settings → AI'
    })
    expect(threadInsights(1, 't5', noKey.status().features).summary).toBeNull()
    expect(off.calls).toHaveLength(0)
    expect(noKey.calls).toHaveLength(0)
  })
})
