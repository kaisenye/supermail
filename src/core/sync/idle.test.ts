import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountConfig } from '../accounts/config.js'

vi.mock('./imap.js', () => ({ createClient: vi.fn() }))

import { createClient } from './imap.js'
import { restartIdleWatchers, stopIdleWatcher, watchMailbox } from './idle.js'

class FakeClient extends EventEmitter {
  opened: string[] = []
  loggedOut = false
  connect = vi.fn(async () => {})
  mailboxOpen = vi.fn(async (path: string) => {
    this.opened.push(path)
  })
  logout = vi.fn(async () => {
    this.loggedOut = true
  })
  // Resolves only when IDLE ends, as imapflow's does.
  idle = vi.fn(() => new Promise<boolean>(() => {}))
}

const mocked = vi.mocked(createClient)
let clients: FakeClient[]
const config = { email: 'me@example.com' } as AccountConfig

beforeEach(() => {
  vi.useFakeTimers()
  clients = []
  mocked.mockImplementation(async () => {
    const c = new FakeClient()
    clients.push(c)
    return c as never
  })
})

afterEach(() => {
  stopIdleWatcher()
  vi.useRealTimers()
  mocked.mockReset()
})

describe('IDLE watchers', () => {
  it('parks one connection per watched mailbox and reports which changed', async () => {
    const inbox = vi.fn()
    const sent = vi.fn()
    watchMailbox(config, 'inbox', 'INBOX', inbox)
    watchMailbox(config, 'sent', 'Sent Messages', sent)
    await vi.advanceTimersByTimeAsync(0)
    expect(clients.map((c) => c.opened)).toEqual([['INBOX'], ['Sent Messages']])

    clients[1].emit('exists')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(inbox).not.toHaveBeenCalled()
  })

  it('starts IDLE as soon as the mailbox is open, not after imapflow\'s 15 s pause', async () => {
    watchMailbox(config, 'sent', 'Sent', vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(clients[0].idle).toHaveBeenCalledTimes(1)
  })

  it('does not open a second connection for the same mailbox', async () => {
    watchMailbox(config, 'sent', 'Sent', vi.fn())
    watchMailbox(config, 'sent', 'Sent', vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(clients).toHaveLength(1)
  })

  it('moves to the new path when the folder for a role changes', async () => {
    watchMailbox(config, 'sent', 'Sent', vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    watchMailbox(config, 'sent', 'Sent Items', vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(clients[0].loggedOut).toBe(true)
    expect(clients[1].opened).toEqual(['Sent Items'])
  })

  it('reconnects at once on wake, without waiting out a backoff', async () => {
    watchMailbox(config, 'inbox', 'INBOX', vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    // The old socket died in sleep; the server close lands later and must not
    // schedule a second reconnect on top of the fresh one.
    restartIdleWatchers()
    await vi.advanceTimersByTimeAsync(0)
    expect(clients).toHaveLength(2)
    expect(clients[0].loggedOut).toBe(true)
    expect(clients[1].opened).toEqual(['INBOX'])
    clients[0].emit('close')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(clients).toHaveLength(2)
  })

  it('stops every mailbox of one account', async () => {
    watchMailbox(config, 'inbox', 'INBOX', vi.fn())
    watchMailbox(config, 'sent', 'Sent', vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    stopIdleWatcher('ME@example.com')
    expect(clients.every((c) => c.loggedOut)).toBe(true)
  })

  it('a restart during a slow connect leaves one connection, not two', async () => {
    // The first createClient waits (an OAuth refresh right after wake).
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    mocked.mockImplementation(async () => {
      const c = new FakeClient()
      clients.push(c)
      if (calls++ === 0) await gate
      return c as never
    })
    watchMailbox(config, 'inbox', 'INBOX', vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    restartIdleWatchers()
    await vi.advanceTimersByTimeAsync(0)
    release()
    await vi.advanceTimersByTimeAsync(0)
    const live = clients.filter((c) => c.opened.length && !c.loggedOut)
    expect(live).toHaveLength(1)
    expect(clients[0].loggedOut).toBe(true)
  })
})
