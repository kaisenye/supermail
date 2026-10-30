import type { ImapFlow, ListResponse } from 'imapflow'
import { describe, expect, it, vi } from 'vitest'
import { fetchEnvelopes, parseReferences, storeFlag, toMailboxInfo } from './imap.js'

const list = (o: Record<string, unknown>): ListResponse =>
  ({ path: 'X', name: 'X', flags: new Set<string>(), ...o }) as unknown as ListResponse

describe('toMailboxInfo', () => {
  it('drops special-use that imapflow guessed from the folder name', () => {
    const info = toMailboxInfo(list({ specialUse: '\\Archive', specialUseSource: 'name' }))
    expect(info.specialUse).toBeNull()
  })

  it('keeps special-use the server advertised', () => {
    const info = toMailboxInfo(list({ specialUse: '\\Sent', specialUseSource: 'extension' }))
    expect(info.specialUse).toBe('\\Sent')
  })

  it('keeps special-use when no source is reported', () => {
    expect(toMailboxInfo(list({ specialUse: '\\Sent' })).specialUse).toBe('\\Sent')
  })

  it('marks \\NoSelect containers as not selectable', () => {
    const info = toMailboxInfo(list({ flags: new Set(['\\NoSelect']) }))
    expect(info.selectable).toBe(false)
  })
})

describe('parseReferences', () => {
  it('returns null for an empty References followed by another field', () => {
    expect(parseReferences(Buffer.from('References: \r\nList-Id: <l@x>\r\n\r\n'))).toBeNull()
  })

  it('does not read past References into the next field', () => {
    const h = 'References: <a@x> <b@x>\r\nList-Id: <dev.list.test>\r\n\r\n'
    expect(parseReferences(Buffer.from(h))).toEqual(['<a@x>', '<b@x>'])
  })

  it('unfolds continuation lines', () => {
    const h = 'References: <a@x>\r\n <b@x>\r\n\t<c@x>\r\nPrecedence: bulk\r\n\r\n'
    expect(parseReferences(Buffer.from(h))).toEqual(['<a@x>', '<b@x>', '<c@x>'])
  })

  it('finds References when it is not the first fetched field', () => {
    const h = 'List-Id: <l@x>\r\nReferences: <a@x>\r\n\r\n'
    expect(parseReferences(Buffer.from(h))).toEqual(['<a@x>'])
  })
})

describe('storeFlag', () => {
  const fake = (result: boolean) => {
    const release = vi.fn()
    const client = {
      getMailboxLock: vi.fn(async () => ({ release })),
      messageFlagsAdd: vi.fn(async () => result),
      messageFlagsRemove: vi.fn(async () => result)
    }
    return { client: client as unknown as ImapFlow, raw: client, release }
  }

  it('resolves when the server accepts the STORE', async () => {
    const f = fake(true)
    await storeFlag(f.client, 'INBOX', 7, 'Work', true, true)
    expect(f.raw.messageFlagsAdd).toHaveBeenCalledWith('7', ['Work'], { uid: true, useLabels: true })
    expect(f.release).toHaveBeenCalled()
  })

  // imapflow returns false on NO/BAD instead of throwing; FlagWriter must see a permanent failure.
  it('throws a NO when imapflow reports a rejected label STORE', async () => {
    const f = fake(false)
    await expect(storeFlag(f.client, 'INBOX', 7, 'Work', true, true)).rejects.toMatchObject({
      message: 'STORE X-GM-LABELS rejected',
      responseStatus: 'NO'
    })
    expect(f.release).toHaveBeenCalled()
  })

  it('throws a NO when imapflow reports a rejected flag removal', async () => {
    const f = fake(false)
    await expect(storeFlag(f.client, 'INBOX', 7, '\\Seen', false)).rejects.toMatchObject({
      message: 'STORE FLAGS rejected',
      responseStatus: 'NO'
    })
    expect(f.raw.messageFlagsRemove).toHaveBeenCalled()
  })
})

describe('fetchEnvelopes on an already-selected mailbox', () => {
  // imapflow skips SELECT when the path is already open and never updates
  // uidNext afterwards, so a pooled connection that left Sent selected
  // reports the UIDNEXT from the previous refresh.
  const pooled = (opts: { selected: boolean }) => {
    const stale = { path: 'Sent', uidValidity: 7n, uidNext: 11, exists: 10 }
    const client: Record<string, unknown> = {
      mailbox: opts.selected ? stale : false,
      noop: vi.fn(async () => {
        // The server reports the new message as EXISTS; uidNext stays stale.
        ;(client.mailbox as typeof stale).exists = 11
      }),
      getMailboxLock: vi.fn(async () => {
        // A fresh SELECT replaces the mailbox object with current values.
        if (!opts.selected) client.mailbox = { path: 'Sent', uidValidity: 7n, uidNext: 12, exists: 11 }
        return { release() {} }
      }),
      fetch: vi.fn(async function* () {
        yield { uid: 11, flags: new Set<string>(), envelope: { messageId: '<two@t>', subject: 'two' } }
      })
    }
    return client
  }

  it('fetches mail that arrived since the last refresh despite a stale uidNext', async () => {
    const client = pooled({ selected: true })
    const { messages } = await fetchEnvelopes(client as unknown as ImapFlow, 'Sent', {
      sinceUid: 10,
      limit: 50,
      accountId: 1,
      folderId: 1
    })
    expect(client.noop).toHaveBeenCalled()
    expect(messages.map((m) => m.uid)).toEqual([11])
  })

  it('still trusts uidNext from a fresh SELECT', async () => {
    const client = pooled({ selected: false })
    const { messages } = await fetchEnvelopes(client as unknown as ImapFlow, 'Sent', {
      sinceUid: 11,
      limit: 50,
      accountId: 1,
      folderId: 1
    })
    expect(client.noop).not.toHaveBeenCalled()
    expect(client.fetch).not.toHaveBeenCalled()
    expect(messages).toEqual([])
  })
})
