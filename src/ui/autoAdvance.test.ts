import { describe, expect, it } from 'vitest'

/**
 * Index math for auto-advance after triage. The triaged row is removed, so the
 * same index now points at the next message — except at the end of the list,
 * where it would point past it.
 */
function nextIndex(triagedIndex: number, rowsAfter: number): number | null {
  if (rowsAfter === 0) return null
  const i = Math.min(triagedIndex, rowsAfter - 1)
  return i >= 0 ? i : null
}

describe('auto-advance', () => {
  it('stays on the same index, which is now the next message', () => {
    // Triaged row 2 of 10 -> 9 remain -> index 2 is what was row 3.
    expect(nextIndex(2, 9)).toBe(2)
  })

  it('clamps at the end instead of running past it', () => {
    // Triaged the last row: index 9 no longer exists among 9 rows.
    expect(nextIndex(9, 9)).toBe(8)
  })

  it('returns null when the folder is now empty', () => {
    expect(nextIndex(0, 0)).toBeNull()
  })

  it('handles triaging the first row', () => {
    expect(nextIndex(0, 5)).toBe(0)
  })
})
