import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { upsertMessage } from '../store/repo.js'
import { parseProcessor } from '../pipeline/parse.js'
import { runPipeline } from '../pipeline/pipeline.js'
import { enqueueOutbox, getOutbox } from './outbox.js'
import { cancelAndNotify, cancelScheduledOnReply, onScheduledCancelled, outboxThreadIds } from './cancelOnReply.js'

const ME = 'me@x.test'
const HOUR = 3_600_000
let uid = 0

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'cancelreply-')), 't.db'))
  uid = 0
  const db = getDb()
  db.prepare('INSERT INTO accounts (id,email) VALUES (1,?),(2,?)').run(ME, 'me2@y.test')
  db.prepare(
    `INSERT INTO folders (id,account_id,path,name,role) VALUES
       (1,1,'INBOX','INBOX','inbox'),(2,1,'Sent','Sent','sent'),(3,2,'INBOX','INBOX','inbox')`
  ).run()
  // The conversations the scheduled replies answer, received yesterday.
  msg({ id: '<a@z>', thread: '<a@z>', from: 'ann@z.test', date: Date.now() - 24 * HOUR })
  msg({ id: '<b@z>', thread: '<b@z>', from: 'bob@z.test', date: Date.now() - 24 * HOUR })
})

function msg(o: {
  account?: number
  folder?: number
  id: string
  thread: string
  from: string
  inReplyTo?: string | null
  date?: number
}): number {
  uid++
  return upsertMessage({
    account_id: o.account ?? 1,
    folder_id: o.folder ?? 1,
    uid,
    message_id: o.id,
    thread_id: o.thread,
    in_reply_to: o.inReplyTo ?? null,
    from_addr: o.from,
    from_name: null,
    to_addrs: '[]',
    cc_addrs: '[]',
    subject: 'Re: plan',
    date: o.date ?? Date.now() + 60_000,
    snippet: null
  })
}

function schedule(o: { account?: number; inReplyTo: string; refs?: string; cancel?: boolean; sendAt?: number }) {
  return enqueueOutbox({
    account_id: o.account ?? 1,
    draft_message_id: null,
    to_addrs: 'them@z.test',
    subject: 'Re: plan',
    in_reply_to: o.inReplyTo,
    references_header: o.refs ?? o.inReplyTo,
    send_at: o.sendAt ?? Date.now() + HOUR,
    cancel_on_reply: o.cancel === false ? 0 : 1
  })
}

const status = (id: number) => getOutbox(id)?.status

describe('cancel a scheduled reply on a reply', () => {
  it('cancels the scheduled reply on the thread someone answered, and only that one', () => {
    const a = schedule({ inReplyTo: '<a@z>' })
    const b = schedule({ inReplyTo: '<b@z>' })
    const reply = msg({ id: '<a2@z>', thread: '<a@z>', from: 'carl@z.test', inReplyTo: '<a@z>' })
    expect(cancelScheduledOnReply(reply)).toEqual([
      { outboxId: a.id, accountId: 1, subject: 'Re: plan', to: 'them@z.test' }
    ])
    expect([status(a.id), status(b.id)]).toEqual(['cancelled', 'pending'])
  })

  it('finds the thread through References when the replied-to message is not local', () => {
    const a = schedule({ inReplyTo: '<gone@z>', refs: '<a@z> <gone@z>' })
    const reply = msg({ id: '<a3@z>', thread: '<a@z>', from: 'carl@z.test' })
    expect(cancelScheduledOnReply(reply).map((c) => c.outboxId)).toEqual([a.id])
  })

  it('leaves my own mail, opted-out rows, due rows and older mail alone', () => {
    const a = schedule({ inReplyTo: '<a@z>' })
    const off = schedule({ inReplyTo: '<a@z>', cancel: false })
    const due = schedule({ inReplyTo: '<a@z>', sendAt: Date.now() - 1 })
    expect(cancelScheduledOnReply(msg({ id: '<m1@x>', thread: '<a@z>', from: 'ME@x.test' }))).toEqual([])
    expect(cancelScheduledOnReply(msg({ id: '<m2@x>', thread: '<a@z>', from: 'carl@z.test', folder: 2 }))).toEqual([])
    expect(
      cancelScheduledOnReply(msg({ id: '<old@z>', thread: '<a@z>', from: 'carl@z.test', date: Date.now() - HOUR }))
    ).toEqual([])
    expect([status(a.id), status(off.id), status(due.id)]).toEqual(['pending', 'pending', 'pending'])
  })

  it('stays inside the account', () => {
    const a = schedule({ inReplyTo: '<a@z>' })
    const other = msg({ account: 2, folder: 3, id: '<a4@z>', thread: '<a@z>', from: 'carl@z.test' })
    expect(cancelScheduledOnReply(other)).toEqual([])
    expect(status(a.id)).toBe('pending')
  })

  it('reads the ids a send is threaded on', () => {
    expect(outboxThreadIds({ in_reply_to: '<b@z>', references_header: '<a@z>  <b@z> junk' })).toEqual(['<b@z>', '<a@z>'])
    expect(outboxThreadIds({ in_reply_to: null, references_header: null })).toEqual([])
  })

  it('runs after the pipeline stores a synced reply, and tells listeners', async () => {
    const a = schedule({ inReplyTo: '<a@z>' })
    const seen: number[] = []
    const off = onScheduledCancelled((c) => seen.push(...c.map((x) => x.outboxId)))
    try {
      await runPipeline(
        {
          accountId: 1,
          folderId: 1,
          uid: 99,
          envelope: {
            messageId: '<a5@z>',
            inReplyTo: '<a@z>',
            references: ['<a@z>'],
            from: { address: 'carl@z.test' },
            subject: 'Re: plan',
            date: new Date(Date.now() + 60_000)
          },
          flags: []
        },
        [parseProcessor]
      )
      expect(status(a.id)).toBe('cancelled')
      expect(seen).toEqual([a.id])
      // Already cancelled: a second pass (the body fetch) reports nothing.
      expect(cancelAndNotify(getDb().prepare("SELECT id FROM messages WHERE message_id = '<a5@z>'").pluck().get() as number)).toEqual([])
    } finally {
      off()
    }
  })
})
