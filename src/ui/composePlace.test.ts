import { describe, expect, it } from 'vitest'
import { composeDirty, composeInline } from './composePlace'

const thread = { threadId: 't1', accountId: 2 }
const reply = { mode: 'reply' as const, threadId: 't1', accountId: 2 }

describe('where a reply is written', () => {
  it('inline, at the end of the thread it answers', () => {
    expect(composeInline(reply, thread, false)).toBe(true)
    expect(composeInline({ ...reply, mode: 'forward' }, thread, false)).toBe(true)
    // A thread opened without an account (one-account paths) matches on id.
    expect(composeInline(reply, { threadId: 't1' }, false)).toBe(true)
  })

  it('never under another thread, even one with the same id in another account', () => {
    expect(composeInline(reply, { threadId: 't2', accountId: 2 }, false)).toBe(false)
    expect(composeInline(reply, { threadId: 't1', accountId: 3 }, false)).toBe(false)
  })

  it('as a page for a new message, with no thread open, or over Tasks', () => {
    expect(composeInline({ ...reply, mode: 'new' }, thread, false)).toBe(false)
    expect(composeInline(reply, null, false)).toBe(false)
    expect(composeInline(reply, thread, true)).toBe(false)
    expect(composeInline(null, thread, false)).toBe(false)
  })
})

describe('closing compose keeps a draft only when something changed', () => {
  const base = { to: 'a@x.com', cc: '', bcc: '', subject: 'Hi', body: '<p><br></p><div class="sovo-signature">S</div>', attachments: 0 }
  it('an untouched compose (or reopened draft) is not saved again', () => {
    expect(composeDirty(base, { ...base })).toBe(false)
  })
  it('any edit to recipients, subject, body or attachments counts', () => {
    expect(composeDirty(base, { ...base, to: 'a@x.com, b@y.com' })).toBe(true)
    expect(composeDirty(base, { ...base, bcc: 'c@z.com' })).toBe(true)
    expect(composeDirty(base, { ...base, subject: 'Hi there' })).toBe(true)
    expect(composeDirty(base, { ...base, body: '<p>Thanks</p><div class="sovo-signature">S</div>' })).toBe(true)
    expect(composeDirty(base, { ...base, attachments: 1 })).toBe(true)
  })
})
