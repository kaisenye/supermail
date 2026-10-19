import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import { accountOfMessage, groupByAccount } from './repo.js'

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'owner-')), 't.db'))
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (1,'a@b.test'),(2,'c@d.test')").run()
  db.prepare('INSERT INTO messages (id, account_id) VALUES (10,1),(11,2),(12,1)').run()
})

describe('message ownership', () => {
  it('finds the account that owns a message', () => {
    expect(accountOfMessage(11)).toBe(2)
    expect(accountOfMessage(999)).toBeNull()
  })

  it('groups ids by account, keeping order and dropping unknown ids', () => {
    expect([...groupByAccount([12, 11, 999, 10])]).toEqual([
      [1, [12, 10]],
      [2, [11]]
    ])
  })
})
