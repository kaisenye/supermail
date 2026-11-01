import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissToast, pauseToasts, resetToasts, resumeToasts, showToast, toast, useToasts, TOAST_EXIT_MS } from './toasts'

const live = () => useToasts.getState().toasts.filter((t) => !t.leaving)

beforeEach(() => {
  vi.useFakeTimers()
  resetToasts()
})
afterEach(() => vi.useRealTimers())

describe('toasts', () => {
  it('show, time out by kind, then leave after their exit', () => {
    toast.info('Saved')
    toast.error('Could not move')
    expect(live().map((t) => [t.kind, t.title])).toEqual([
      ['info', 'Saved'],
      ['error', 'Could not move']
    ])
    vi.advanceTimersByTime(4000)
    expect(live().map((t) => t.title)).toEqual(['Could not move'])
    vi.advanceTimersByTime(TOAST_EXIT_MS)
    expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(['Could not move'])
  })

  it('replace the toast with the same key instead of stacking another', () => {
    toast.error('First', { key: 'action' })
    toast.error('Second', { key: 'action' })
    expect(live().map((t) => t.title)).toEqual(['Second'])
  })

  it('stay until dismissed when sticky', () => {
    toast.error('Sync failed', { key: 'sync', duration: null })
    vi.advanceTimersByTime(60_000)
    expect(live()).toHaveLength(1)
    dismissToast('sync')
    expect(live()).toHaveLength(0)
  })

  it('hold their timers while hovered, except undo, which runs out on schedule', () => {
    const expired: string[] = []
    toast.info('Info')
    showToast({ key: 'undo', kind: 'undo', title: 'Trashed', duration: 3000, onExpire: () => expired.push('undo') })
    pauseToasts()
    vi.advanceTimersByTime(5000)
    expect(live().map((t) => t.title)).toEqual(['Info'])
    expect(expired).toEqual(['undo'])
    resumeToasts()
    vi.advanceTimersByTime(4000)
    expect(live()).toHaveLength(0)
  })

  it('keep at most five, the oldest leaving first', async () => {
    for (let i = 1; i <= 6; i++) toast.info(`T${i}`)
    await Promise.resolve()
    expect(live().map((t) => t.title)).toEqual(['T2', 'T3', 'T4', 'T5', 'T6'])
  })
})
