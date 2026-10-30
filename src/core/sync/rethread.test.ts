import { describe, expect, it } from 'vitest'
import { assignThreads } from './rethread.js'
import { threadKey } from '../pipeline/threadKey.js'

describe('assignThreads', () => {
  // msg 9: original. msg 8: reply carrying References. msg 40: Exmail Sent reply,
  // References stripped, In-Reply-To only. Scan order puts the Sent copy first,
  // which used to make its own id the union root.
  const sent = { id: 40, own: '<t3>', irt: '<t2>', refs: [] as string[] }
  const reply = { id: 8, own: '<t2>', irt: '<t1>', refs: ['<t1>'] }
  const original = { id: 9, own: '<t1>', irt: null, refs: [] as string[] }

  it('gives the whole conversation the root the body pass derives for it', () => {
    const out = assignThreads([sent, reply, original])
    expect(out.get(40)).toBe('<t1>')
    expect(out.get(8)).toBe('<t1>')
    expect(out.get(9)).toBe('<t1>')
    // The body pass on the original and the reply yields the same key.
    expect(threadKey(original.refs, original.irt, original.own)).toBe('<t1>')
    expect(threadKey(reply.refs, reply.irt, reply.own)).toBe('<t1>')
  })

  it('does not depend on scan order', () => {
    const a = assignThreads([original, reply, sent])
    const b = assignThreads([sent, original, reply])
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort())
  })

  it('keeps unrelated mail and id-less mail apart', () => {
    const out = assignThreads([
      original,
      { id: 50, own: '<other>', irt: null, refs: [] },
      { id: 51, own: null, irt: null, refs: [] }
    ])
    expect(out.get(50)).toBe('<other>')
    expect(out.get(51)).toBe('local:51')
  })
})
