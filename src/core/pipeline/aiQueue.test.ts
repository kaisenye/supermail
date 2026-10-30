import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { setSetting } from '../store/repo.js'
import { parseProcessor } from './parse.js'
import { runPipeline } from './pipeline.js'

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'aiqueue-')), 't.db'))
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
  getDb().prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox')").run()
})

const raw = (uid: number, bulk = false) => ({
  accountId: 1,
  folderId: 1,
  uid,
  envelope: {
    messageId: `<p${uid}@t>`,
    from: { address: 'ann@x.test' },
    to: [{ address: 'me@x.test' }],
    subject: 'Hi',
    date: new Date()
  },
  flags: [],
  listHeaders: { unsubscribe: null, oneClick: false, bulk }
})

const count = () => (getDb().prepare('SELECT count(*) AS c FROM ai_jobs').get() as { c: number }).c

describe('the pipeline queues background AI', () => {
  it('after storing new Inbox mail, only when a background feature is on', async () => {
    await runPipeline(raw(1), [parseProcessor])
    expect(count()).toBe(0)
    setSetting('ai_classify', '1')
    const r = await runPipeline(raw(2), [parseProcessor])
    expect(r.errors).toEqual([])
    expect(count()).toBe(1)
    await runPipeline(raw(3, true), [parseProcessor])
    expect(count()).toBe(1)
  })
})
