import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ImapFlow } from 'imapflow'
import { closeDb, getDb, initDb } from '../store/db.js'
import { backfillListHeaders } from './headerBackfill.js'

const NEWSLETTER =
  'List-Unsubscribe: <mailto:u@news.test>, <https://news.test/u>\r\n' +
  'List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\n'
const LIST_ONLY = 'List-Id: <dev.lists.test>\r\n\r\n'
const PERSONAL = 'References: <a@x>\r\n\r\n'

/** Fake IMAP: serves raw header text per (path, uid) and records what was asked. */
function fakeClient(byPath: Record<string, Record<number, string>>) {
  const fetched: { path: string; range: string; query: Record<string, unknown> }[] = []
  let current = ''
  const client = {
    async getMailboxLock(path: string) {
      current = path
      return { release() {} }
    },
    async *fetch(range: string, query: Record<string, unknown>) {
      fetched.push({ path: current, range, query })
      const box = byPath[current] ?? {}
      for (const uid of range.split(',').map(Number)) {
        if (box[uid] !== undefined) yield { uid, headers: Buffer.from(box[uid]) }
      }
    }
  }
  return { client: client as unknown as ImapFlow, fetched }
}

function row(account: number, uid: number) {
  return getDb()
    .prepare(
      'SELECT list_unsubscribe, unsubscribe_one_click, bulk FROM messages WHERE account_id = ? AND uid = ?'
    )
    .get(account, uid) as { list_unsubscribe: string | null; unsubscribe_one_click: number; bulk: number }
}

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'hdrfill-')), 't.db'))
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test'),(2,'other@x.test')").run()
  db.prepare(
    "INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox'),(2,2,'INBOX','inbox')"
  ).run()
  const ins = db.prepare(
    'INSERT INTO messages (account_id,folder_id,uid,message_id,thread_id,body_fetched) VALUES (?,?,?,?,?,1)'
  )
  // Pre-v18 rows: bodies already fetched, columns at their defaults.
  ins.run(1, 1, 10, '<n@x>', '<n@x>')
  ins.run(1, 1, 11, '<l@x>', '<l@x>')
  ins.run(1, 1, 12, '<p@x>', '<p@x>')
  // Same uid in another account must not be touched.
  ins.run(2, 2, 10, '<o@x>', '<o@x>')
})

describe('backfillListHeaders', () => {
  it('fills list columns on already-fetched mail from headers alone', async () => {
    const { client, fetched } = fakeClient({ INBOX: { 10: NEWSLETTER, 11: LIST_ONLY, 12: PERSONAL } })
    const r = await backfillListHeaders(client, 1, [{ id: 1, path: 'INBOX' }])

    expect(r).toEqual({ scanned: 3, updated: 2 })
    expect(row(1, 10)).toEqual({
      list_unsubscribe: '<mailto:u@news.test>, <https://news.test/u>',
      unsubscribe_one_click: 1,
      bulk: 1
    })
    expect(row(1, 11)).toEqual({ list_unsubscribe: null, unsubscribe_one_click: 0, bulk: 1 })
    expect(row(1, 12)).toEqual({ list_unsubscribe: null, unsubscribe_one_click: 0, bulk: 0 })
    expect(row(2, 10)).toEqual({ list_unsubscribe: null, unsubscribe_one_click: 0, bulk: 0 })

    // Header lines only — never bodies, envelopes or flags.
    expect(fetched).toHaveLength(1)
    expect(fetched[0].query).toEqual({ uid: true, headers: expect.arrayContaining(['list-unsubscribe']) })
    expect(fetched[0].range).toBe('10,11,12')
  })

  it('skips rows the new pipeline already flagged', async () => {
    getDb().prepare('UPDATE messages SET bulk = 1 WHERE account_id = 1 AND uid = 11').run()
    const { client, fetched } = fakeClient({ INBOX: { 10: NEWSLETTER, 12: PERSONAL } })
    await backfillListHeaders(client, 1, [{ id: 1, path: 'INBOX' }])
    expect(fetched[0].range).toBe('10,12')
  })

  it('marks the thread dirty so list_rows sees the new bulk flag', async () => {
    getDb().prepare('DELETE FROM list_dirty').run()
    const { client } = fakeClient({ INBOX: { 11: LIST_ONLY } })
    await backfillListHeaders(client, 1, [{ id: 1, path: 'INBOX' }])
    const dirty = getDb().prepare('SELECT account_id, thread_key FROM list_dirty').all()
    expect(dirty).toEqual([{ account_id: 1, thread_key: '<l@x>' }])
  })

  it('does not open a folder with nothing to check', async () => {
    getDb().prepare('UPDATE messages SET bulk = 1 WHERE account_id = 1').run()
    const { client, fetched } = fakeClient({})
    expect(await backfillListHeaders(client, 1, [{ id: 1, path: 'INBOX' }])).toEqual({
      scanned: 0,
      updated: 0
    })
    expect(fetched).toHaveLength(0)
  })
})
