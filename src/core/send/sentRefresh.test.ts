import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { upsertMessage } from '../store/repo.js'
import { hasSentCopy, serialPerKey, waitForSentCopy } from './sentRefresh.js'

const noSleep = async (): Promise<void> => {}

describe('waitForSentCopy', () => {
  it('keeps polling after a poll that only brought an earlier send', async () => {
    // Two quick sends: the second send's first poll stores the FIRST copy
    // (n = 1). That used to end the wait before the second copy was filed.
    let polls = 0
    let mine = false
    const found = await waitForSentCopy({
      poll: async () => {
        polls++
        if (polls === 2) mine = true
        return 1
      },
      stored: () => mine,
      sleep: noSleep
    })
    expect(found).toBe(true)
    expect(polls).toBe(2)
  })

  it('does not poll when the copy is already local', async () => {
    let polls = 0
    const found = await waitForSentCopy({
      poll: async () => ++polls,
      stored: () => true,
      sleep: noSleep
    })
    expect([found, polls]).toEqual([true, 0])
  })

  it('gives up after the attempts it was given', async () => {
    let polls = 0
    const slept: number[] = []
    const found = await waitForSentCopy({
      poll: async () => {
        polls++
        return 0
      },
      stored: () => false,
      sleep: async (ms) => void slept.push(ms),
      attempts: 3,
      intervalMs: 10
    })
    expect([found, polls]).toEqual([false, 3])
    // No sleep after the last attempt.
    expect(slept).toEqual([10, 10])
  })
})

describe('serialPerKey', () => {
  it('runs one account at a time, in order, and other accounts alongside', async () => {
    const run = serialPerKey()
    const log: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const a1 = run(1, async () => {
      log.push('a1 start')
      await gate
      log.push('a1 end')
    })
    const a2 = run(1, async () => void log.push('a2'))
    const b1 = run(2, async () => void log.push('b1'))
    await b1
    expect(log).toEqual(['a1 start', 'b1'])
    release()
    await Promise.all([a1, a2])
    expect(log).toEqual(['a1 start', 'b1', 'a1 end', 'a2'])
  })

  it('keeps going after a task fails', async () => {
    const run = serialPerKey()
    await expect(run(1, async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await expect(run(1, async () => 7)).resolves.toBe(7)
  })
})

describe('hasSentCopy', () => {
  beforeEach(() => {
    closeDb()
    initDb(join(mkdtempSync(join(tmpdir(), 'sentcopy-')), 't.db'))
    const db = getDb()
    db.prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
    db.prepare(
      "INSERT INTO folders (id,account_id,path,name,role) VALUES (1,1,'Sent','Sent','sent'),(2,1,'INBOX','INBOX','inbox')"
    ).run()
  })

  it('finds the copy by Message-ID in that folder only', () => {
    upsertMessage({
      account_id: 1,
      folder_id: 1,
      uid: 5,
      message_id: '<s1@x>',
      thread_id: '<s1@x>',
      in_reply_to: null,
      from_addr: 'me@x.test',
      from_name: null,
      to_addrs: '[]',
      cc_addrs: '[]',
      subject: 'Hi',
      date: 1,
      snippet: null
    })
    expect(hasSentCopy(1, 1, '<s1@x>')).toBe(true)
    expect(hasSentCopy(1, 2, '<s1@x>')).toBe(false)
    expect(hasSentCopy(1, 1, '<s2@x>')).toBe(false)
  })
})
