import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { openThreadTarget } from './threadTarget'

const row = (id: number, thread_id: string, account_id = 1) => ({ id, thread_id, account_id })

describe('openThreadTarget', () => {
  const ot = { threadId: 't-open', messageId: 10 }

  it('finds the open row by message id', () => {
    const rows = [row(5, 't-a'), row(10, 't-open'), row(7, 't-b')]
    expect(openThreadTarget(rows, ot)).toEqual({ index: 1, ids: [10] })
  })

  it('finds the row by thread id after a sync re-sorted it with a new newest id', () => {
    // A new reply (id 99) made the thread's row move to the top; the cursor
    // (index 1) now sits on another conversation.
    const rows = [row(99, 't-open'), row(5, 't-a'), row(7, 't-b')]
    expect(openThreadTarget(rows, ot)).toEqual({ index: 0, ids: [99] })
  })

  it('falls back to the open message id, never the cursor row, when the row is gone', () => {
    const rows = [row(5, 't-a'), row(7, 't-b')]
    expect(openThreadTarget(rows, ot)).toEqual({ index: -1, ids: [10] })
  })

  it("matches the thread id only within the open thread's account", () => {
    // All inboxes: the same mailing-list thread shows once per account. A new
    // reply replaced the open row's newest id, so only the thread id is left.
    const rows = [row(50, 't-open', 1), row(60, 't-open', 2), row(5, 't-a', 2)]
    expect(openThreadTarget(rows, { ...ot, accountId: 2 })).toEqual({ index: 1, ids: [60] })
    expect(openThreadTarget(rows, { ...ot, accountId: 1 })).toEqual({ index: 0, ids: [50] })
  })

  it("falls back to the open message id when only another account's row shares the thread id", () => {
    const rows = [row(50, 't-open', 1), row(5, 't-a', 2)]
    expect(openThreadTarget(rows, { ...ot, accountId: 2 })).toEqual({ index: -1, ids: [10] })
  })

  it('does not match an empty thread id', () => {
    const rows = [row(5, '')]
    expect(openThreadTarget(rows, { threadId: '', messageId: 10 })).toEqual({
      index: -1,
      ids: [10]
    })
  })
})

describe('triageFromThread passes explicit ids', () => {
  const s = readFileSync(join(__dirname, 'App.tsx'), 'utf8')
  const body = s.slice(s.indexOf('const triageFromThread'), s.indexOf('const starFromThread'))

  it('resolves the target with openThreadTarget and hands its ids to the action', () => {
    expect(body).toContain('openThreadTarget(')
    expect(body).toContain('await act(ids)')
    expect(body).not.toContain('r.id === ot.messageId')
  })

  it('moveSelected prefers explicit ids over the cursor', () => {
    const m = s.slice(s.indexOf('const moveSelected'), s.indexOf('const triageSelected'))
    expect(m).toContain('explicit?: number[]')
    expect(m).toContain('explicit ?? targetIds()')
  })

  it('every thread-mode triage key goes through triageFromThread with ids', () => {
    for (const f of ['triageSelected', 'doneSelected', 'notDoneSelected', 'spamSelected']) {
      expect(s).toContain(`triageFromThread(${f})`)
      const def = s.slice(s.indexOf(`const ${f} = useCallback(`))
      expect(def.slice(0, 200)).toContain('ids?: number[]')
    }
  })
})
