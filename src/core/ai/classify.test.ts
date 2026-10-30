import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fakeAi } from '../services/ai/fake.js'
import { AiError } from '../services/ai/types.js'
import { getClassification } from '../store/ai.js'
import { closeDb, getDb, initDb } from '../store/db.js'
import { listView } from '../store/listRows.js'
import { upsertMessage } from '../store/repo.js'
import { CLASSIFY_SCHEMA, classifyMessage, parseClassification } from './classify.js'
import { threadInsights } from './insights.js'

let row: number
beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'classify-')), 't.db'))
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
  db.prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox')").run()
  db.prepare("INSERT INTO replied_senders (account_id,address) VALUES (1,'ann@x.test')").run()
  row = upsertMessage({
    account_id: 1,
    folder_id: 1,
    uid: 1,
    message_id: '<c@t>',
    thread_id: 'c',
    in_reply_to: null,
    from_addr: 'Ann@x.test',
    from_name: 'Ann',
    to_addrs: '[]',
    cc_addrs: '[]',
    subject: 'Lunch?',
    date: 1000,
    snippet: 'Are you free',
    body_text: 'Are you free for lunch on Friday?',
    body_fetched: 1,
    flags: '[]'
  })
})

describe('the classifier', () => {
  it('asks with the sender signals and a strict schema, then stores the verdict', async () => {
    const ai = fakeAi(() => JSON.stringify({ important: false, category: 'personal', reason: 'Lunch invite from Ann' }))
    expect(await classifyMessage(ai, row)).toBe(true)
    const call = ai.calls[0]
    expect(call).toMatchObject({ feature: 'classify', background: true })
    expect(call.req.schema).toEqual(CLASSIFY_SCHEMA)
    expect(call.req.prompt).toContain('You have written to this sender before: yes')
    expect(call.req.prompt).toContain('VIP sender: no')
    expect(call.req.prompt).toContain('Are you free for lunch on Friday?')
    expect(getClassification(1, '<c@t>')).toEqual({
      important: false,
      category: 'personal',
      reason: 'Lunch invite from Ann',
      model: 'fake-model'
    })
    // The verdict overrides the heuristic (Ann is a replied sender).
    expect(listView(1, { query: 'is:other' }).map((r) => r.subject)).toEqual(['Lunch?'])
  })

  it('repairs a weak answer and rejects a broken one', () => {
    expect(parseClassification('{"important":true,"category":"weird","reason":"  "}')).toEqual({
      important: true,
      category: 'other',
      reason: 'No reason given'
    })
    expect(() => parseClassification('{"category":"work"}')).toThrow(AiError)
  })

  it('shows the verdict in the thread only while the classifier is on', async () => {
    const ai = fakeAi(() => JSON.stringify({ important: true, category: 'personal', reason: 'Ann asks about lunch' }))
    expect(threadInsights(1, 'c', ai.status().features).classification).toBeNull()
    await classifyMessage(ai, row)
    expect(threadInsights(1, 'c', ai.status().features).classification).toMatchObject({
      important: true,
      reason: 'Ann asks about lunch'
    })
    const off = fakeAi(() => '', { features: { classify: false } }).status().features
    expect(threadInsights(1, 'c', off).classification).toBeNull()
  })
})
