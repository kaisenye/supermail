import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import { upsertMessage } from './repo.js'

const ACC = 1
let folder: number

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'threadkeep-')), 't.db'))
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (?,'a@b.test')").run(ACC)
  folder = Number(
    db
      .prepare("INSERT INTO folders (account_id,path,name) VALUES (?,'Sent','Sent')")
      .run(ACC).lastInsertRowid
  )
})

function put(thread: string | null, bodyPass: boolean) {
  return upsertMessage({
    account_id: ACC,
    folder_id: folder,
    uid: 40,
    message_id: '<t3>',
    thread_id: thread,
    in_reply_to: bodyPass ? '<t2>' : null,
    from_addr: 'me@b.test',
    from_name: null,
    to_addrs: null,
    cc_addrs: null,
    subject: 'Re: Quote request',
    date: 1,
    snippet: null,
    ...(bodyPass ? { body_text: 'hi', body_fetched: 1 } : {})
  })
}

const threadOf = (id: number) =>
  (getDb().prepare('SELECT thread_id FROM messages WHERE id = ?').get(id) as { thread_id: string })
    .thread_id

describe('upsert keeps a conversation thread', () => {
  it('a body pass does not move a message out of the thread rethread put it in', () => {
    const id = put('<t3>', false)
    getDb().prepare('UPDATE messages SET thread_id = ? WHERE id = ?').run('<t1>', id)
    put('<t2>', true)
    expect(threadOf(id)).toBe('<t1>')
  })

  it('an envelope re-sync does not either', () => {
    const id = put('<t3>', false)
    getDb().prepare('UPDATE messages SET thread_id = ? WHERE id = ?').run('<t1>', id)
    put('<t3>', false)
    expect(threadOf(id)).toBe('<t1>')
  })

  it('a message still threaded on its own id takes the body pass key', () => {
    const id = put('<t3>', false)
    put('<t2>', true)
    expect(threadOf(id)).toBe('<t2>')
  })
})

describe('list_dirty under upsert', () => {
  it('an upsert that changes flags while its thread is already dirty does not throw', () => {
    const id = put('<t3>', false)
    // Inserting the row marked <t3> dirty; no list read has drained it yet.
    expect(() =>
      upsertMessage({
        account_id: ACC,
        folder_id: folder,
        uid: 40,
        message_id: '<t3>',
        thread_id: '<t3>',
        in_reply_to: null,
        from_addr: 'me@b.test',
        from_name: null,
        to_addrs: null,
        cc_addrs: null,
        subject: 'Re: Quote request',
        date: 1,
        snippet: null,
        flags: '["\\\\Seen"]'
      })
    ).not.toThrow()
    expect(
      (getDb().prepare('SELECT flags FROM messages WHERE id = ?').get(id) as { flags: string }).flags
    ).toContain('Seen')
  })
})
