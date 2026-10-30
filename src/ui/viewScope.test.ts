import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { REMINDERS_VIEW_ID, UNIFIED_VIEW_ID } from './store'
import { doneAction, pushSyncTarget, undoRepaint, viewKey } from './viewScope'

const app = readFileSync(join(__dirname, 'App.tsx'), 'utf8')
const body = (name: string): string => {
  const start = app.indexOf(`const ${name} = useCallback`)
  expect(start).toBeGreaterThan(-1)
  return app.slice(start, app.indexOf('\n  )\n', start))
}

const inbox = { email: 'me@x.test', activeFolderId: 1, splitId: 'all', chip: null }

describe('undoRepaint', () => {
  it('splices rows back only into the view they came from', () => {
    expect(undoRepaint(viewKey(inbox), viewKey({ ...inbox }))).toBe('restore')
  })

  it('reloads after a folder, split, chip or account change (e, g e, z)', () => {
    const origin = viewKey(inbox)
    expect(undoRepaint(origin, viewKey({ ...inbox, activeFolderId: 9 }))).toBe('reload')
    expect(undoRepaint(origin, viewKey({ ...inbox, splitId: 'vip' }))).toBe('reload')
    expect(undoRepaint(origin, viewKey({ ...inbox, chip: 'unread' }))).toBe('reload')
    expect(undoRepaint(origin, viewKey({ ...inbox, email: 'other@x.test' }))).toBe('reload')
  })
})

describe('undo wiring in App', () => {
  it('every list undo repaints through the view check, never a blind restoreRows', () => {
    for (const name of ['moveSelected', 'remindSelected', 'dismissReminders', 'muteSelected']) {
      const b = body(name)
      expect(b).toContain('viewKey(useStore.getState())')
      expect(b).toContain('repaintAfterUndo(origin')
      expect(b).not.toMatch(/\brestoreRows\(/)
    }
  })
})

describe('Done in the Reminders view', () => {
  it('dismisses the reminder there, and moves mail everywhere else', () => {
    expect(doneAction(REMINDERS_VIEW_ID, REMINDERS_VIEW_ID)).toBe('dismissReminder')
    expect(doneAction(1, REMINDERS_VIEW_ID)).toBe('move')
  })

  it('never holds a move from the Reminders view: dismissReminders clears with undo', () => {
    const b = body('dismissReminders')
    expect(b).toContain('window.api.clearReminders(ids)')
    expect(b).toContain('window.api.restoreReminders(res.cleared)')
    expect(b).not.toContain('moveMessages')
    expect(body('doneSelected')).toContain("doneAction(useStore.getState().activeFolderId, REMINDERS_VIEW_ID) === 'dismissReminder'")
  })

  it('Send + Done from Reminders dismisses the reminder too, under the one send undo', () => {
    const b = body('onSent')
    const branch = b.indexOf("doneAction(origin.folderId, REMINDERS_VIEW_ID) === 'dismissReminder'")
    const move = b.indexOf('window.api.moveMessages([doneId]')
    expect(branch).toBeGreaterThan(-1)
    expect(move).toBeGreaterThan(branch)
    const dismiss = b.slice(branch, move)
    expect(dismiss).toContain('window.api.clearReminders([doneId])')
    expect(dismiss).toContain('dropRows([doneId])')
    expect(dismiss).toContain('return')
    // One undo entry takes back the send and the dismissal, in that order.
    const undo = dismiss.slice(dismiss.indexOf('pushUndo('))
    expect(undo.indexOf('await undoSend()')).toBeGreaterThan(-1)
    expect(undo.indexOf('window.api.restoreReminders(cleared.cleared)')).toBeGreaterThan(undo.indexOf('await undoSend()'))
    expect(undo).toContain('repaintAfterUndo(origin, removed)')
    expect(dismiss.match(/pushUndo\(/g)).toHaveLength(1)
  })
})

describe('IDLE push routing', () => {
  const view = { email: 'qa@x.com', activeFolderId: 3 }
  it('refreshes the view for a push from the account on screen', () => {
    expect(pushSyncTarget('qa@x.com', view, UNIFIED_VIEW_ID)).toBe('view')
    expect(pushSyncTarget('QA@x.com', view, UNIFIED_VIEW_ID)).toBe('view')
    expect(pushSyncTarget(undefined, view, UNIFIED_VIEW_ID)).toBe('view')
  })
  // Syncing the active account for another account's push left that mail
  // waiting for the 60 s poll.
  it('syncs the pushing account itself when it is not on screen', () => {
    expect(pushSyncTarget('friend@x.com', view, UNIFIED_VIEW_ID)).toBe('account')
  })
  it('refreshes the unified inbox, which already syncs every account', () => {
    expect(pushSyncTarget('friend@x.com', { ...view, activeFolderId: UNIFIED_VIEW_ID }, UNIFIED_VIEW_ID)).toBe('view')
  })
})
