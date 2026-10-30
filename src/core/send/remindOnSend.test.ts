import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./smtp.js', () => ({
  sendSmtp: vi.fn(async () => ({ messageId: '<sent-1@x.test>' }))
}))

import type { AccountConfig } from '../accounts/config.js'
import { closeDb, getDb, initDb } from '../store/db.js'
import { flushOutboxRow } from './flush.js'
import { enqueueOutbox, reminderTimeAfterSend, remindAtError } from './outbox.js'

// smtpSavesSent skips the Sent APPEND, so no IMAP connection is needed.
const config = { smtpSavesSent: true } as unknown as AccountConfig

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'remindsend-')), 't.db'))
  getDb().prepare("INSERT INTO accounts (id,email) VALUES (1,'me@x.test')").run()
})

describe('remind me if no reply, on send', () => {
  it('keeps remind_at on the outbox row', () => {
    const row = enqueueOutbox({ account_id: 1, draft_message_id: null, to_addrs: 'a@x.test', send_at: 0, remind_at: 9000 })
    expect(row.remind_at).toBe(9000)
    expect(enqueueOutbox({ account_id: 1, draft_message_id: null, to_addrs: 'a@x.test', send_at: 0 }).remind_at).toBeNull()
  })

  it('saves an if-no-reply reminder keyed by the sent Message-ID', async () => {
    const remindAt = Date.now() + 86_400_000
    const row = enqueueOutbox({
      account_id: 1,
      draft_message_id: null,
      to_addrs: 'a@x.test',
      subject: 'Quote',
      send_at: Date.now(),
      remind_at: remindAt
    })
    expect(await flushOutboxRow(config, row)).toEqual({ ok: true })
    expect(
      getDb().prepare('SELECT account_id, message_id, subject, remind_at, if_no_reply FROM reminders').all()
    ).toEqual([{ account_id: 1, message_id: '<sent-1@x.test>', subject: 'Quote', remind_at: remindAt, if_no_reply: 1 }])
  })

  it('saves nothing without remind_at', async () => {
    const row = enqueueOutbox({ account_id: 1, draft_message_id: null, to_addrs: 'a@x.test', send_at: 0 })
    await flushOutboxRow(config, row)
    expect(getDb().prepare('SELECT count(*) AS c FROM reminders').get()).toEqual({ c: 0 })
  })

  it('rejects a reminder that is not later than the send time', () => {
    expect(remindAtError(null, 5000)).toBeNull()
    expect(remindAtError(undefined, 5000)).toBeNull()
    expect(remindAtError(6000, 5000)).toBeNull()
    expect(remindAtError(5000, 5000)).toMatch(/later than the send time/)
    expect(remindAtError(4000, 5000)).toMatch(/later than the send time/)
  })

  it('keeps the chosen gap when the send went out late', () => {
    expect(reminderTimeAfterSend({ send_at: 1000, remind_at: 9000 }, 2000)).toBe(9000)
    // Retried an hour late: remind 30 min after the actual send, as chosen.
    expect(reminderTimeAfterSend({ send_at: 0, remind_at: 1800 }, 3600)).toBe(5400)
    expect(reminderTimeAfterSend({ send_at: 0, remind_at: null }, 3600)).toBeNull()
  })

  it('saves no reminder when remind_at is earlier than send_at', async () => {
    const now = Date.now()
    const row = enqueueOutbox({
      account_id: 1,
      draft_message_id: null,
      to_addrs: 'a@x.test',
      send_at: now,
      remind_at: now - 60_000
    })
    expect(await flushOutboxRow(config, row)).toEqual({ ok: true })
    expect(getDb().prepare('SELECT count(*) AS c FROM reminders').get()).toEqual({ c: 0 })
  })

  it('shifts a reminder that is already past at send time by how late the send was', async () => {
    const now = Date.now()
    const row = enqueueOutbox({
      account_id: 1,
      draft_message_id: null,
      to_addrs: 'a@x.test',
      send_at: now - 3_600_000,
      remind_at: now - 1_800_000
    })
    expect(await flushOutboxRow(config, row)).toEqual({ ok: true })
    const r = getDb().prepare('SELECT remind_at FROM reminders').get() as { remind_at: number }
    expect(r.remind_at).toBeGreaterThan(now)
    expect(r.remind_at - Date.now()).toBeLessThanOrEqual(1_800_000)
    expect(r.remind_at - now).toBeGreaterThanOrEqual(1_800_000)
  })
})
