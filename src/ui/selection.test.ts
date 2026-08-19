import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

interface Sel {
  checkedIds: number[]
  lastCheckedIndex: number | null
  selectedIndex: number
}

const ROWS = Array.from({ length: 8 }, (_, i) => ({ id: 100 + i }))

/** Mirrors store.ts. A plain click re-anchors, so shift extends from it. */
function select(index: number, s: Sel): Sel {
  return { ...s, selectedIndex: index, lastCheckedIndex: index }
}

function toggle(id: number, index: number, s: Sel): Sel {
  const has = s.checkedIds.includes(id)
  return {
    checkedIds: has ? s.checkedIds.filter((x) => x !== id) : [...s.checkedIds, id],
    lastCheckedIndex: index,
    selectedIndex: index
  }
}

function range(toIndex: number, s: Sel): Sel {
  const from = s.lastCheckedIndex ?? s.selectedIndex
  const lo = Math.min(from, toIndex)
  const hi = Math.max(from, toIndex)
  const next = new Set(s.checkedIds)
  for (let i = lo; i <= hi; i++) if (ROWS[i]) next.add(ROWS[i].id)
  return { checkedIds: [...next], lastCheckedIndex: toIndex, selectedIndex: toIndex }
}

const empty: Sel = { checkedIds: [], lastCheckedIndex: null, selectedIndex: 0 }

describe('shift-range selection', () => {
  it('includes the row that was shift-clicked', () => {
    const s = range(5, select(1, empty))
    expect(s.checkedIds).toEqual([101, 102, 103, 104, 105])
  })

  it('extends backwards too', () => {
    expect(range(1, select(5, empty)).checkedIds.sort()).toEqual([101, 102, 103, 104, 105])
  })

  /** The anchor used to survive an uncheck, so ranges started far too early. */
  it('anchors on the last row clicked, not a cleared checkbox', () => {
    let s = toggle(101, 1, empty)
    s = toggle(101, 1, s)
    s = select(6, s)
    expect(range(7, s).checkedIds).toEqual([106, 107])
  })

  it('keeps rows checked from an earlier range', () => {
    let s = range(2, select(1, empty))
    s = range(6, select(5, s))
    expect(s.checkedIds.sort()).toEqual([101, 102, 105, 106])
  })

  it('selects a single row when anchor and target match', () => {
    expect(range(3, select(3, empty)).checkedIds).toEqual([103])
  })
})

describe('selection survives a refresh', () => {
  // setRows keeps ids that still exist; setPageRows clears. A background sync
  // used to take the setPageRows path and wipe the selection under the user.
  function setRows(ids: number[], s: Sel): Sel {
    const live = new Set(ids)
    return { ...s, checkedIds: s.checkedIds.filter((id) => live.has(id)) }
  }

  it('keeps checked rows when the same page is re-read', () => {
    const s = range(4, select(1, empty))
    expect(setRows(ROWS.map((r) => r.id), s).checkedIds).toEqual([101, 102, 103, 104])
  })

  it('drops only the rows that went away', () => {
    const s = range(4, select(1, empty))
    expect(setRows([101, 103], s).checkedIds).toEqual([101, 103])
  })
})

describe('store wiring', () => {
  // The functions above mirror store.ts rather than importing it (the store
  // pulls in the whole app), so the re-anchor is asserted against the source.
  const store = readFileSync(join(__dirname, 'store.ts'), 'utf8')

  it('re-anchors the range on a plain click', () => {
    expect(store).toContain('set({ selectedIndex, lastCheckedIndex: selectedIndex })')
  })

  it('re-anchors on j/k navigation too', () => {
    expect(store).toContain('set({ selectedIndex: next, lastCheckedIndex: next })')
  })

  it('refreshes in place without clearing the selection', () => {
    const app = readFileSync(join(__dirname, 'App.tsx'), 'utf8')
    expect(app).toContain('if (keepPage) setRows(rows)')
    expect(app).toMatch(/refreshRows[\s\S]{0,400}setRows\(await fetchPage/)
  })
})

describe('row click wiring', () => {
  // Shift on the row body used to fall through to plain select, so the user saw
  // a moved cursor and an unchanged selection.
  const list = readFileSync(join(__dirname, 'views/MessageList.tsx'), 'utf8')

  it('ignores the change event that follows a shift-click', () => {
    // preventDefault stops the native toggle but React fires change anyway, so
    // the ranged-in row was immediately unchecked again.
    expect(list).toContain('shiftHandled.current = true')
    const onChange = list.match(/onChange=\{\(\) => \{[\s\S]*?\}\}/)
    expect(onChange?.[0]).toContain('if (shiftHandled.current)')
    expect(onChange?.[0]).toContain('return')
  })

  it('routes a shift-click on the row into the range handler', () => {
    // Anchored on onSelect so it cannot pass by matching the checkbox handler,
    // which has its own identical-looking shiftKey branch.
    const rowHandler = list.match(/onClick=\{\(e\) => \{[\s\S]*?onSelect\(item\.index\)[\s\S]*?\}\}/)
    expect(rowHandler).not.toBeNull()
    expect(rowHandler?.[0]).toContain('e.shiftKey')
    expect(rowHandler?.[0]).toContain('onToggleCheck(r.id, item.index, true)')
  })
})
