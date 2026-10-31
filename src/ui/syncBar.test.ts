import { describe, expect, it } from 'vitest'
import { syncBar, trackSync } from './syncBar'

describe('sync progress bar', () => {
  it('shows a first sync with its count, summed across accounts', () => {
    let s = trackSync({}, { phase: 'folder', email: 'a@x', count: 300, expected: 1_000 })
    s = trackSync(s, { phase: 'folder', email: 'b@x', count: 100, expected: 1_000 })
    expect(syncBar(s)).toEqual({ done: 400, expected: 2_000, pct: 20 })
  })

  it('stays hidden for the usual few new messages', () => {
    const s = trackSync({}, { phase: 'folder', email: 'a@x', count: 1, expected: 3 })
    expect(syncBar(s)).toBeNull()
  })

  it('drops an account once its pass is done or fails', () => {
    let s = trackSync({}, { phase: 'folder', email: 'a@x', count: 10, expected: 500 })
    s = trackSync(s, { phase: 'done', email: 'a@x' })
    expect(syncBar(s)).toBeNull()
    s = trackSync(s, { phase: 'folder', email: 'b@x', count: 10, expected: 500 })
    s = trackSync(s, { phase: 'error', email: 'b@x' })
    expect(s).toEqual({})
  })

  it('ignores events with no count, such as connect', () => {
    const s = trackSync({}, { phase: 'connect', email: 'a@x' })
    expect(s).toEqual({})
  })
})
