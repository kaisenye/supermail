import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { getMessage } from '../store/repo.js'
import { messageLabels } from '../store/labels.js'
import { parseProcessor } from './parse.js'
import { runPipeline } from './pipeline.js'

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'parse-')), 't.db'))
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (1,'me@gmail.com')").run()
  getDb().prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox')").run()
})

describe('list headers and labels through the pipeline', () => {
  it('writes them on the envelope pass', async () => {
    const r = await runPipeline(
      {
        accountId: 1,
        folderId: 1,
        uid: 7,
        envelope: { messageId: '<n@list.test>', subject: 'News', date: new Date(1000) },
        flags: [],
        listHeaders: { unsubscribe: '<https://list.test/u>', oneClick: true, bulk: true },
        labels: ['\\Inbox', 'Newsletters']
      },
      [parseProcessor]
    )
    const m = getMessage(r.id!)!
    expect([m.list_unsubscribe, m.unsubscribe_one_click, m.bulk]).toEqual(['<https://list.test/u>', 1, 1])
    expect(messageLabels(r.id!)).toEqual(['Newsletters'])
  })

  it('writes them on the body pass from the raw headers', async () => {
    const source =
      'From: news@list.test\r\nTo: me@gmail.com\r\nSubject: News\r\nMessage-ID: <b@list.test>\r\n' +
      'List-Unsubscribe: <mailto:u@list.test>\r\nContent-Type: text/plain\r\n\r\nhello\r\n'
    const r = await runPipeline({ accountId: 1, folderId: 1, uid: 8, source }, [parseProcessor])
    const m = getMessage(r.id!)!
    expect([m.list_unsubscribe, m.unsubscribe_one_click, m.bulk]).toEqual(['<mailto:u@list.test>', 0, 1])
  })
})
