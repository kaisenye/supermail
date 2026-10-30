import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { parseProcessor } from './parse.js'
import { runPipeline } from './pipeline.js'

/**
 * Mail that arrives after the one-time account rethread is threaded per
 * message. An Exmail reply chain has gaps in References (Exmail strips it from
 * its own sent mail), so the new message has to join the thread of any stored
 * message it mentions rather than start one rooted at references[0].
 */

const INBOX = 1
const SENT = 2

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'threadjoin-')), 't.db'))
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@exmail.test')").run()
  db.prepare("INSERT INTO accounts (id,email) VALUES (2,'other@exmail.test')").run()
  db.prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox')").run()
  db.prepare("INSERT INTO folders (id,account_id,path,role) VALUES (2,1,'Sent','sent')").run()
  db.prepare("INSERT INTO folders (id,account_id,path,role) VALUES (3,2,'INBOX','inbox')").run()
})

interface Msg {
  folderId: number
  uid: number
  own: string
  irt?: string
  refs?: string[]
  accountId?: number
}

function envelope(m: Msg) {
  return runPipeline(
    {
      accountId: m.accountId ?? 1,
      folderId: m.folderId,
      uid: m.uid,
      envelope: {
        messageId: m.own,
        inReplyTo: m.irt ?? null,
        references: m.refs ?? null,
        subject: 'Probe',
        date: new Date(m.uid * 1000)
      },
      flags: []
    },
    [parseProcessor]
  )
}

function body(m: Msg) {
  const source =
    'From: a@exmail.test\r\nTo: me@exmail.test\r\nSubject: Re: Probe\r\n' +
    `Message-ID: ${m.own}\r\n` +
    (m.irt ? `In-Reply-To: ${m.irt}\r\n` : '') +
    (m.refs?.length ? `References: ${m.refs.join(' ')}\r\n` : '') +
    'Content-Type: text/plain\r\n\r\nhello\r\n'
  return runPipeline(
    { accountId: m.accountId ?? 1, folderId: m.folderId, uid: m.uid, source },
    [parseProcessor]
  )
}

const threadOf = (own: string, accountId = 1) =>
  (
    getDb()
      .prepare('SELECT thread_id FROM messages WHERE account_id = ? AND message_id = ?')
      .get(accountId, own) as { thread_id: string }
  ).thread_id

const root: Msg = { folderId: INBOX, uid: 1, own: '<1@x>' }
const sentReply: Msg = { folderId: SENT, uid: 2, own: '<2@x>', irt: '<1@x>' }
const inboxReply: Msg = { folderId: INBOX, uid: 3, own: '<3@x>', irt: '<2@x>', refs: ['<2@x>'] }

describe('new mail joins the thread of a message it mentions', () => {
  it('an Exmail chain with no References on the Sent reply stays one thread', async () => {
    await envelope(root)
    await envelope(sentReply)
    await envelope(inboxReply)
    expect([threadOf('<1@x>'), threadOf('<2@x>'), threadOf('<3@x>')]).toEqual(['<1@x>', '<1@x>', '<1@x>'])
  })

  it('stays one thread through every body fetch and a resync', async () => {
    await envelope(root)
    await envelope(sentReply)
    await envelope(inboxReply)
    await body(root)
    await body(inboxReply)
    await body(sentReply)
    await envelope(inboxReply)
    expect([threadOf('<1@x>'), threadOf('<2@x>'), threadOf('<3@x>')]).toEqual(['<1@x>', '<1@x>', '<1@x>'])
  })

  it('a reply that arrived before the message it answers is pulled in when that arrives', async () => {
    await envelope(root)
    await envelope(inboxReply)
    expect(threadOf('<3@x>')).toBe('<2@x>')
    await envelope(sentReply)
    expect([threadOf('<1@x>'), threadOf('<2@x>'), threadOf('<3@x>')]).toEqual(['<1@x>', '<1@x>', '<1@x>'])
  })

  it('repairs a message already stored split on its next sync', async () => {
    await envelope(root)
    await envelope(sentReply)
    await envelope(inboxReply)
    getDb().prepare("UPDATE messages SET thread_id = '<2@x>' WHERE message_id = '<3@x>'").run()
    await body(inboxReply)
    expect(threadOf('<3@x>')).toBe('<1@x>')
  })

  it('keeps the list read model to one conversation', async () => {
    await envelope(root)
    await envelope(sentReply)
    await envelope(inboxReply)
    const { refreshListRows } = await import('../store/listRows.js')
    refreshListRows()
    const keys = getDb()
      .prepare('SELECT DISTINCT thread_key FROM list_rows WHERE account_id = 1')
      .all() as { thread_key: string }[]
    expect(keys.map((k) => k.thread_key)).toEqual(['<1@x>'])
  })

  it('does not reach into another account', async () => {
    await envelope({ ...root, folderId: 3, accountId: 2 })
    await envelope(sentReply)
    expect(threadOf('<1@x>', 2)).toBe('<1@x>')
    await envelope({ ...inboxReply, refs: ['<1@x>'] })
    await envelope({ folderId: 3, uid: 9, own: '<9@x>', irt: '<2@x>', accountId: 2 })
    // Account 2 has no <2@x>, so its reply keys on in-reply-to as usual.
    expect(threadOf('<9@x>', 2)).toBe('<2@x>')
  })

  it('leaves unrelated mail alone', async () => {
    await envelope(root)
    await envelope({ folderId: INBOX, uid: 5, own: '<5@x>' })
    await envelope(sentReply)
    expect(threadOf('<5@x>')).toBe('<5@x>')
  })
})
