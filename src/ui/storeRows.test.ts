import { describe, expect, it } from 'vitest'
import { useStore } from './store.js'
import { isInboxZero } from './streak.js'

const rows = (ids: number[]) => ids.map((id) => ({ id })) as never

describe('removeRows / restoreRows keep totalRows in step', () => {
  it('Done on every conversation drops the total to zero, so the zero state can show', () => {
    useStore.setState({ rows: rows([1, 2, 3]), totalRows: 3, selectedIndex: 0, checkedIds: [] })
    useStore.getState().removeRows([1, 2, 3])
    const st = useStore.getState()
    expect(st.rows).toHaveLength(0)
    expect(st.totalRows).toBe(0)
    expect(
      isInboxZero({ plainInbox: true, total: st.totalRows, hasSyncedOnce: true, syncError: null })
    ).toBe(true)
  })

  it('counts only the rows actually removed and never goes below zero', () => {
    useStore.setState({ rows: rows([1, 2, 3]), totalRows: 40 })
    useStore.getState().removeRows([2, 99])
    expect(useStore.getState().totalRows).toBe(39)
    useStore.setState({ rows: rows([1]), totalRows: 0 })
    useStore.getState().removeRows([1])
    expect(useStore.getState().totalRows).toBe(0)
  })

  it('undo puts the count back', () => {
    useStore.setState({ rows: rows([1, 2, 3]), totalRows: 33 })
    const removed = useStore.getState().removeRows([1, 3])
    expect(useStore.getState().totalRows).toBe(31)
    useStore.getState().restoreRows(removed)
    expect(useStore.getState().totalRows).toBe(33)
    expect(useStore.getState().rows.map((r) => r.id)).toEqual([1, 2, 3])
  })
})

describe('action errors are not sync errors', () => {
  it('an action error leaves syncError alone, so the empty state stays correct', () => {
    useStore.setState({ syncError: null })
    useStore.getState().setActionError('Labels are Gmail only')
    const st = useStore.getState()
    expect(st.actionError).toBe('Labels are Gmail only')
    expect(st.syncError).toBeNull()
    expect(
      isInboxZero({ plainInbox: true, total: 0, hasSyncedOnce: true, syncError: st.syncError })
    ).toBe(true)
  })
})

describe('hover moves the cursor without moving the range anchor', () => {
  it('shift-click after hovering ranges from the row last clicked, not the hovered one', () => {
    useStore.setState({ rows: rows([1, 2, 3, 4, 5, 6]), checkedIds: [], lastCheckedIndex: null, selectedIndex: 0 })
    const st = useStore.getState()
    st.toggleChecked(2, 1)
    // The mouse travels down to the row it will shift-click, hovering on the way.
    st.hoverCursor(3)
    st.hoverCursor(4)
    expect(useStore.getState().selectedIndex).toBe(4)
    useStore.getState().checkRange(4)
    expect(useStore.getState().checkedIds.sort()).toEqual([2, 3, 4, 5])
  })
})
