import { describe, expect, it } from 'vitest'
import { undoWindowMs } from './undoWindow.js'

describe('undoWindowMs', () => {
  it('reads the four allowed choices', () => {
    for (const s of [3, 5, 10, 20]) expect(undoWindowMs({ undo_seconds: String(s) })).toBe(s * 1000)
  })
  it('falls back to 3s for anything else', () => {
    expect(undoWindowMs({})).toBe(3000)
    expect(undoWindowMs({ undo_seconds: '7' })).toBe(3000)
    expect(undoWindowMs({ undo_seconds: 'abc' })).toBe(3000)
  })
})
