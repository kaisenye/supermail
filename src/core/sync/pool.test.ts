import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountConfig } from '../accounts/config.js'

// The real createClient resolves auth and builds an ImapFlow; the pool only
// needs something that connects, logs out and reports `usable`.
vi.mock('./imap.js', () => ({ createClient: vi.fn() }))
vi.mock('../accounts/oauth.js', () => ({ invalidateAccessToken: vi.fn() }))

import { invalidateAccessToken } from '../accounts/oauth.js'
import { createClient } from './imap.js'
import { ImapPool } from './pool.js'

const mocked = vi.mocked(createClient)

function fakeClient() {
  return {
    usable: true,
    on: vi.fn(),
    connect: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    noop: vi.fn(async () => {})
  }
}

const config = { email: 'me@example.com' } as AccountConfig

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** Fails the test instead of hanging until vitest's own timeout. */
function within<T>(p: Promise<T>, ms = 500): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('hung')), ms))
  ])
}

let pool: ImapPool | null = null

afterEach(async () => {
  await pool?.close()
  pool = null
  mocked.mockReset()
  vi.mocked(invalidateAccessToken).mockReset()
})

describe('ImapPool', () => {
  it('drops idle connections on wake but leaves one in use alone', async () => {
    const made: ReturnType<typeof fakeClient>[] = []
    mocked.mockImplementation(async () => {
      const c = fakeClient()
      made.push(c)
      return c as never
    })
    pool = new ImapPool(config)
    const p = pool
    const busy = deferred<void>()
    const held = p.withConnection(async () => busy.promise)
    // made[0] is held, so this lease opens made[1], which then sits idle.
    await p.withConnection(async () => {})

    p.dropIdle()
    expect(made[1].logout).toHaveBeenCalled()
    expect(made[0].logout).not.toHaveBeenCalled()
    busy.resolve()
    await held

    // A later lease gets the connection that was busy, never the dropped one.
    const used = await p.withConnection(async (c) => c)
    expect(used).not.toBe(made[1])
  })

  it('wakes a parked waiter when a connection attempt fails', async () => {
    let calls = 0
    mocked.mockImplementation(async () => {
      if (calls++ === 0) throw new Error('no token')
      return fakeClient() as never
    })
    pool = new ImapPool(config)
    const p = pool
    // The two leases that do connect stay busy until the fourth caller is
    // served, so only the failed attempt's freed slot can serve it.
    const fourthDone = deferred<void>()
    const hold = () => p.withConnection(async () => fourthDone.promise)
    const first = p.withConnection(async () => {})
    const second = hold()
    const third = hold()
    const fourth = p.withConnection(async () => 'ok')

    await expect(first).rejects.toThrow('no token')
    expect(await within(fourth)).toBe('ok')
    fourthDone.resolve()
    await within(Promise.all([second, third]))
  })

  it('wakes a parked waiter when connect() fails', async () => {
    let calls = 0
    mocked.mockImplementation(async () => {
      const c = fakeClient()
      if (calls++ === 0) c.connect.mockRejectedValue(new Error('refused'))
      return c as never
    })
    pool = new ImapPool(config)
    const p = pool
    const fourthDone = deferred<void>()
    const hold = () => p.withConnection(async () => fourthDone.promise)
    const first = p.withConnection(async () => {})
    const second = hold()
    const third = hold()
    const fourth = p.withConnection(async () => 'ok')

    await expect(first).rejects.toThrow('refused')
    expect(await within(fourth)).toBe('ok')
    fourthDone.resolve()
    await within(Promise.all([second, third]))
  })

  it('never connects a client that arrives after close()', async () => {
    const late = fakeClient()
    const gate = deferred<typeof late>()
    mocked.mockImplementation(() => gate.promise as never)
    pool = new ImapPool(config)
    const lease = pool.withConnection(async () => {})
    await pool.close()
    gate.resolve(late)

    await expect(lease).rejects.toThrow('pool closed')
    expect(late.connect).not.toHaveBeenCalled()
  })

  it('forgets a rejected OAuth access token so the next connect refreshes', async () => {
    const authFail = Object.assign(new Error('AUTHENTICATE failed'), { authenticationFailed: true })
    const c = fakeClient()
    c.connect.mockRejectedValueOnce(authFail)
    mocked.mockResolvedValue(c as never)
    const oauth = {
      email: 'me@gmail.com',
      auth: { kind: 'oauth2', provider: 'google', ref: 'r1' }
    } as AccountConfig
    pool = new ImapPool(oauth)
    await expect(pool.withConnection(async () => {})).rejects.toBe(authFail)
    expect(invalidateAccessToken).toHaveBeenCalledWith('r1')
  })

  it('leaves the token cache alone for other connect failures', async () => {
    const c = fakeClient()
    c.connect.mockRejectedValueOnce(new Error('ETIMEDOUT'))
    mocked.mockResolvedValue(c as never)
    const oauth = {
      email: 'me@gmail.com',
      auth: { kind: 'oauth2', provider: 'google', ref: 'r1' }
    } as AccountConfig
    pool = new ImapPool(oauth)
    await expect(pool.withConnection(async () => {})).rejects.toThrow('ETIMEDOUT')
    expect(invalidateAccessToken).not.toHaveBeenCalled()
  })
})
