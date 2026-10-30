import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { isImeKey } from './ime'

describe('isImeKey', () => {
  it('flags keys that belong to an IME composition', () => {
    expect(isImeKey({ isComposing: true, keyCode: 13 })).toBe(true)
    expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true)
  })

  it('lets plain keys through', () => {
    expect(isImeKey({ isComposing: false, keyCode: 13 })).toBe(false)
    expect(isImeKey({ isComposing: false, keyCode: 9 })).toBe(false)
  })
})

describe('command palette', () => {
  it('ignores IME keys before it handles Tab, Enter or arrows', () => {
    const src = readFileSync(join(__dirname, 'views/CommandPalette.tsx'), 'utf8')
    const body = src.slice(src.indexOf('const onKey = (e: KeyboardEvent)'))
    const guard = body.indexOf('if (isImeKey(e)) return')
    expect(guard).toBeGreaterThan(-1)
    for (const k of ["'Escape'", "'Tab'", "'Enter'", "'ArrowDown'"]) expect(guard).toBeLessThan(body.indexOf(k))
  })
})
