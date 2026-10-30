import { describe, expect, it } from 'vitest'
import { cycleIndex, openActiveTarget, positionLabel, stepIndex, toggleAllExpanded } from './threadNav.js'

describe('thread navigation', () => {
  it('steps between messages without leaving the thread', () => {
    expect(stepIndex(0, 1, 3)).toBe(1)
    expect(stepIndex(2, 1, 3)).toBe(2)
    expect(stepIndex(0, -1, 3)).toBe(0)
    expect(stepIndex(0, 1, 0)).toBe(0)
  })

  it('expands every message, or back to the focused one when all are open', () => {
    expect([...toggleAllExpanded(new Set([2]), [1, 2, 3], 2)]).toEqual([1, 2, 3])
    expect([...toggleAllExpanded(new Set([1, 2, 3]), [1, 2, 3], 2)]).toEqual([2])
    expect([...toggleAllExpanded(new Set(), [], null)]).toEqual([])
  })

  it('cycles links from the first (or last, going back) and wraps', () => {
    expect(cycleIndex(null, 1, 3)).toBe(0)
    expect(cycleIndex(null, -1, 3)).toBe(2)
    expect(cycleIndex(2, 1, 3)).toBe(0)
    expect(cycleIndex(0, -1, 3)).toBe(2)
    expect(cycleIndex(null, 1, 0)).toBeNull()
  })

  it('counts the position across pages', () => {
    expect(positionLabel(4, 0, 50, 201)).toBe('5 / 201')
    expect(positionLabel(14, 2, 50, 201)).toBe('115 / 201')
    expect(positionLabel(-1, 0, 50, 201)).toBeNull()
    expect(positionLabel(0, 0, 50, 0)).toBeNull()
  })
})

describe('openActiveTarget (⌘O)', () => {
  const pdf = { id: 1, filename: 'a.pdf' }
  const html = { id: 2, filename: 'invoice.html' }
  const canPreview = (a: { filename: string }) => a.filename.endsWith('.pdf')

  it('opens the link Tab selected', () => {
    expect(openActiveTarget({ links: ['https://x.test'], attachments: [pdf] }, 0, canPreview)).toEqual({
      kind: 'link',
      url: 'https://x.test'
    })
  })

  it('never hands an attachment to the OS directly: preview when possible, else confirm', () => {
    expect(openActiveTarget({ links: ['https://x.test'], attachments: [pdf] }, null, canPreview)).toEqual({
      kind: 'preview',
      attachment: pdf
    })
    expect(openActiveTarget({ links: [], attachments: [html] }, null, canPreview)).toEqual({
      kind: 'confirm',
      attachment: html
    })
  })

  it('does nothing without a loaded body or anything to open', () => {
    expect(openActiveTarget(undefined, null, canPreview)).toBeNull()
    expect(openActiveTarget({ links: [], attachments: [] }, null, canPreview)).toBeNull()
  })
})
