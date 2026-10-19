import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from '../store/db.js'
import { insertMoveJob, listMoveJobs } from '../store/moveJobs.js'
import type { AccountConfig } from '../accounts/config.js'
import { UidValidityChanged } from './imap.js'
import { MissingMailbox, MoveWriter, type MoveRequest } from './moveWriter.js'

const ACC = 1
// The mover is injected, so the IMAP config is never read.
const config = {} as AccountConfig
const job: MoveRequest = { fromPath: 'INBOX', uid: 7, toPath: 'Trash', uidValidity: 42 }

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'moves-')), 't.db'))
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (?,'a@b.test')").run(ACC)
})

const rejected = (): Error => Object.assign(new Error('NO'), { responseStatus: 'NO' })

describe('MoveWriter', () => {
  it('keeps a job on disk until the server confirms it', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const w = new MoveWriter(ACC, config, { move: () => gate })
    w.enqueue(job)
    expect(listMoveJobs(ACC)).toHaveLength(1)
    release()
    await w.whenIdle()
    expect(listMoveJobs(ACC)).toHaveLength(0)
  })

  it('retries a transient failure', async () => {
    const calls: MoveRequest[] = []
    const w = new MoveWriter(ACC, config, {
      retryBaseMs: 0,
      move: async (j) => {
        calls.push(j)
        if (calls.length === 1) throw new Error('socket closed')
      }
    })
    w.enqueue(job)
    await w.whenIdle()
    expect(calls).toEqual([job, job])
    expect(listMoveJobs(ACC)).toHaveLength(0)
  })

  it('drops a job the server rejects', async () => {
    const w = new MoveWriter(ACC, config, {
      retryBaseMs: 0,
      move: async () => {
        throw rejected()
      }
    })
    w.enqueue(job)
    await w.whenIdle()
    expect(listMoveJobs(ACC)).toHaveLength(0)
  })

  it('drops a job whose destination does not exist', async () => {
    const w = new MoveWriter(ACC, config, {
      move: async () => {
        throw new MissingMailbox('Trash')
      }
    })
    w.enqueue(job)
    await w.whenIdle()
    expect(listMoveJobs(ACC)).toHaveLength(0)
  })

  it('keeps a job that never got through, for the next launch', async () => {
    const w = new MoveWriter(ACC, config, {
      retryBaseMs: 0,
      move: async () => {
        throw new Error('offline')
      }
    })
    w.enqueue(job)
    await w.whenIdle()
    expect(listMoveJobs(ACC)).toEqual([
      expect.objectContaining({ from_path: 'INBOX', uid: 7, to_path: 'Trash' })
    ])
  })

  it('replays persisted jobs on resume', async () => {
    insertMoveJob({
      account_id: ACC,
      from_path: 'INBOX',
      uid: 9,
      to_path: 'Archive',
      uidvalidity: 5
    })
    const calls: MoveRequest[] = []
    const w = new MoveWriter(ACC, config, {
      move: async (j) => {
        calls.push(j)
      }
    })
    w.resume()
    await w.whenIdle()
    expect(calls).toEqual([{ fromPath: 'INBOX', uid: 9, toPath: 'Archive', uidValidity: 5 }])
    expect(listMoveJobs(ACC)).toHaveLength(0)
  })

  it('hands the mover the uidvalidity it was enqueued with', async () => {
    const calls: MoveRequest[] = []
    const w = new MoveWriter(ACC, config, {
      move: async (j) => {
        calls.push(j)
      }
    })
    w.enqueue(job)
    await w.whenIdle()
    expect(calls[0].uidValidity).toBe(42)
  })

  it('drops a job whose mailbox was renumbered', async () => {
    let calls = 0
    const w = new MoveWriter(ACC, config, {
      retryBaseMs: 0,
      move: async () => {
        calls++
        throw new UidValidityChanged('INBOX')
      }
    })
    w.enqueue(job)
    await w.whenIdle()
    expect(calls).toBe(1)
    expect(listMoveJobs(ACC)).toHaveLength(0)
  })

  it('does not queue a job twice when resume runs mid-move', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    const w = new MoveWriter(ACC, config, {
      move: async () => {
        calls++
        await gate
      }
    })
    w.enqueue(job)
    w.resume()
    release()
    await w.whenIdle()
    expect(calls).toBe(1)
  })
})
