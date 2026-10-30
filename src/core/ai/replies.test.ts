import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fakeAi } from '../services/ai/fake.js'
import { AiError } from '../services/ai/types.js'
import { getReplyOptions } from '../store/ai.js'
import { closeDb, getDb, initDb } from '../store/db.js'
import { upsertMessage } from '../store/repo.js'
import { threadInsights } from './insights.js'
import { parseReplyOptions, REPLIES_SCHEMA, suggestReplies, suggestRepliesOnce } from './replies.js'

let row: number
beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'replies-')), 't.db'))
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
  getDb().prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox')").run()
  row = upsertMessage({
    account_id: 1,
    folder_id: 1,
    uid: 1,
    message_id: '<r@t>',
    thread_id: 'r',
    in_reply_to: null,
    from_addr: 'ann@x.test',
    from_name: 'Ann',
    to_addrs: JSON.stringify([{ address: 'me@x.test' }]),
    cc_addrs: '[]',
    subject: 'Friday',
    date: Date.now(),
    snippet: 'Are you in?',
    body_text: 'Are you in on Friday?',
    body_fetched: 1,
    flags: '[]'
  })
})

describe('Instant Reply', () => {
  it('asks once with the thread and a strict schema, then serves the cache', async () => {
    const ai = fakeAi(() => JSON.stringify({ options: ['Yes!', 'Not this time.', 'What time?', 'extra'] }))
    expect(await suggestReplies(ai, row, { background: false })).toEqual(['Yes!', 'Not this time.', 'What time?'])
    expect(await suggestReplies(ai, row, { background: true })).toEqual(['Yes!', 'Not this time.', 'What time?'])
    expect(ai.calls).toHaveLength(1)
    expect(ai.calls[0]).toMatchObject({ feature: 'replies', background: false })
    expect(ai.calls[0].req.schema).toEqual(REPLIES_SCHEMA)
    expect(ai.calls[0].req.prompt).toContain('Are you in on Friday?')
    expect(ai.calls[0].req.system).toContain('me@x.test')
    expect(getReplyOptions(1, '<r@t>')).toHaveLength(3)
  })

  it('offers the cached suggestions in the thread view, for the message to answer', async () => {
    const features = fakeAi(() => 'x').status().features
    expect(threadInsights(1, 'r', features).replies).toBeNull()
    expect(threadInsights(1, 'r', features).replyTarget).toBe(row)
    await suggestReplies(fakeAi(() => '{"options":["A","B","C"]}'), row, { background: false })
    expect(threadInsights(1, 'r', features).replies).toEqual({ messageRowId: row, options: ['A', 'B', 'C'] })
    // Instant Reply off: nothing to answer, cached or not.
    const off = fakeAi(() => 'x', { features: { replies: false } }).status().features
    expect(threadInsights(1, 'r', off)).toMatchObject({ replyTarget: null, replies: null })
  })

  it('runs one provider call when the same message is asked for twice at once', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const ai = fakeAi(() => '{"options":["A","B","C"]}')
    const slow = { ...ai, run: async (...a: Parameters<typeof ai.run>) => (await gate, ai.run(...a)) }
    // The worker's background job and the on-demand call race for one message.
    const first = suggestRepliesOnce(slow, row, { background: true })
    const second = suggestRepliesOnce(slow, row, { background: false })
    release()
    expect(await first).toEqual(['A', 'B', 'C'])
    expect(await second).toEqual(['A', 'B', 'C'])
    expect(ai.calls).toHaveLength(1)
    // Done: the next request reads the cache, it does not join a stale promise.
    expect(await suggestRepliesOnce(ai, row, { background: false })).toEqual(['A', 'B', 'C'])
    expect(ai.calls).toHaveLength(1)
  })

  it('frees the slot after a failed run, so a retry calls again', async () => {
    let n = 0
    const failing = fakeAi(() => {
      n++
      throw new Error('boom')
    })
    await expect(suggestRepliesOnce(failing, row, { background: false })).rejects.toThrow('boom')
    await expect(suggestRepliesOnce(failing, row, { background: false })).rejects.toThrow('boom')
    expect(n).toBe(2)
  })

  it('cleans the options and rejects an empty answer', () => {
    expect(parseReplyOptions('{"options":["  Sure.  ", "", 3]}')).toEqual(['Sure.'])
    expect(() => parseReplyOptions('{"options":[]}')).toThrow(AiError)
  })
})
