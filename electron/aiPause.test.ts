import { describe, expect, it, vi } from 'vitest'
import { AI_PAUSE_MS, createAiPause, createAiTick, nextLocalMidnight, pauseUntil } from './aiPause.js'

const NOW = new Date(2026, 9, 30, 14, 30).getTime()

describe('pauseUntil', () => {
  it('backs off a rejected key or a rate limit', () => {
    expect(pauseUntil('auth', NOW)).toBe(NOW + AI_PAUSE_MS)
    expect(pauseUntil('rate', NOW)).toBe(NOW + AI_PAUSE_MS)
  })
  it('holds a spent budget until local midnight', () => {
    expect(pauseUntil('budget', NOW)).toBe(new Date(2026, 9, 31, 0, 0).getTime())
    expect(nextLocalMidnight(new Date(2026, 9, 30, 23, 59).getTime())).toBe(new Date(2026, 9, 31).getTime())
  })
  it('does not pause a clean run or a missing key', () => {
    expect(pauseUntil(null, NOW)).toBeNull()
    expect(pauseUntil('no-key', NOW)).toBeNull()
  })
})

describe('createAiPause', () => {
  it('sits out ticks after an auth stop, logs once, then lifts', () => {
    let t = NOW
    const log = vi.fn()
    const p = createAiPause({ now: () => t, log })
    p.stopped(null)
    expect(p.paused()).toBe(false)
    p.stopped('auth')
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('auth')
    expect(log.mock.calls[0][0]).not.toMatch(/sk-/)
    expect(p.paused()).toBe(true)
    expect(p.reason()).toBe('auth')
    t += AI_PAUSE_MS - 1
    expect(p.paused()).toBe(true)
    t += 1
    expect(p.paused()).toBe(false)
    expect(p.reason()).toBeNull()
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('clears when a new key or settings arrive', () => {
    const p = createAiPause({ now: () => NOW, log: () => {} })
    p.stopped('budget')
    expect(p.paused()).toBe(true)
    p.clear()
    expect(p.paused()).toBe(false)
  })
})

describe('createAiTick', () => {
  it('stops calling the provider after an auth stop until resumed', async () => {
    let t = NOW
    const pause = createAiPause({ now: () => t, log: () => {} })
    const run = vi.fn(async () => ({ done: [] as { kind: 'classify' }[], stopped: 'auth' as const }))
    const tick = createAiTick({ run, notify: () => {}, pause })
    await tick()
    await tick()
    await tick()
    expect(run).toHaveBeenCalledTimes(1)
    pause.clear()
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    t += AI_PAUSE_MS
    await tick()
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('notifies done kinds once each and keeps ticking on a clean run', async () => {
    const pause = createAiPause({ now: () => NOW, log: () => {} })
    const notify = vi.fn()
    const run = vi.fn(async () => ({ done: [{ kind: 'classify' as const }, { kind: 'classify' as const }], stopped: null }))
    const tick = createAiTick({ run, notify, pause })
    await tick()
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledWith(['classify'])
  })

  it('logs a thrown run without pausing', async () => {
    const pause = createAiPause({ now: () => NOW, log: () => {} })
    const log = vi.fn()
    const run = vi.fn(async () => {
      throw new Error('db locked')
    })
    const tick = createAiTick({ run, notify: () => {}, pause, log })
    await tick()
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith('[ai] worker run failed: db locked')
  })
})
