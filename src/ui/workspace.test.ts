import { describe, expect, it } from 'vitest'
import {
  back,
  backOutOf,
  canGoBack,
  canGoForward,
  closeTab,
  currentView,
  cycleTab,
  forward,
  initWorkspace,
  MAX_HISTORY,
  MAX_TABS,
  navigate,
  openTab,
  record,
  restoreWorkspace,
  savedWorkspace,
  selectTab,
  serializeWorkspace,
  workspaceKey,
  type View
} from './workspace.js'

const list = (folderId: number): View => ({ folderId, splitId: 'all', chip: null, thread: null })
const thread = (folderId: number, threadId: string): View => ({
  ...list(folderId),
  thread: { threadId, messageId: 1, accountId: 1 }
})

describe('history', () => {
  it('goes back and forward, and a new step drops the forward entries', () => {
    let ws = initWorkspace(list(1))
    ws = navigate(ws, thread(1, '<a>'))
    ws = navigate(ws, list(2))
    ws = back(ws)!
    expect(currentView(ws)).toEqual(thread(1, '<a>'))
    expect([canGoBack(ws), canGoForward(ws)]).toEqual([true, true])
    ws = navigate(ws, list(3))
    expect(canGoForward(ws)).toBe(false)
    expect(back(back(ws)!)).not.toBeNull()
    expect(forward(ws)).toBeNull()
  })

  it('ignores a step to the view already on screen', () => {
    const ws = initWorkspace(list(1))
    expect(navigate(ws, list(1))).toBe(ws)
    // A newer message in the same thread is still the same place.
    const t = navigate(ws, thread(1, '<a>'))
    expect(navigate(t, { ...thread(1, '<a>'), thread: { threadId: '<a>', messageId: 9, accountId: 1 } })).toBe(t)
  })

  it('keeps at most MAX_HISTORY entries per tab', () => {
    let ws = initWorkspace(list(0))
    for (let i = 1; i <= MAX_HISTORY + 5; i++) ws = navigate(ws, list(i))
    expect(ws.tabs[0].history).toHaveLength(MAX_HISTORY)
    expect(currentView(ws)).toEqual(list(MAX_HISTORY + 5))
  })

  it('records a search-query edit in place instead of as a new step', () => {
    const search = (query: string): View => ({ ...list(-3), query })
    let ws = initWorkspace(list(1))
    ws = record(ws, search('in'))
    ws = record(ws, search('invoice'))
    expect(ws.tabs[0].history).toEqual([list(1), search('invoice')])
    ws = record(ws, list(2))
    expect(ws.tabs[0].history).toHaveLength(3)
  })

  it('backs out of the search page past a thread opened from it', () => {
    const search = (query: string): View => ({ ...list(-3), query })
    const hit: View = { ...search('foo'), thread: { threadId: '<r>', messageId: 1, accountId: 1 } }
    let ws = initWorkspace(list(1))
    ws = record(ws, search(''))
    ws = record(ws, search('foo'))
    ws = record(ws, hit) // open a result
    ws = record(ws, search('foo')) // Esc closes the thread
    // Plain back() would land on the thread again.
    expect(currentView(back(ws)!)).toEqual(hit)
    const out = backOutOf(ws, -3)!
    expect(currentView(out)).toEqual(list(1))
    // Nothing before the search page: null, so App falls back to the Inbox.
    expect(backOutOf(record(initWorkspace(search('')), search('x')), -3)).toBeNull()
  })
})

describe('tabs', () => {
  it('opens a tab after the active one and switches to it', () => {
    let ws = initWorkspace(list(1))
    ws = openTab(ws, list(2))
    ws = selectTab(ws, 0)
    ws = openTab(ws, list(3))
    expect(ws.tabs.map((t) => currentView({ ...ws, active: ws.tabs.indexOf(t) }).folderId)).toEqual([1, 3, 2])
    expect(ws.active).toBe(1)
    expect(new Set(ws.tabs.map((t) => t.id)).size).toBe(3)
  })

  it('keeps each tab its own history', () => {
    let ws = initWorkspace(list(1))
    ws = navigate(ws, list(2))
    ws = openTab(ws, list(5))
    expect(canGoBack(ws)).toBe(false)
    ws = selectTab(ws, 0)
    expect(currentView(back(ws)!)).toEqual(list(1))
  })

  it('stops at MAX_TABS', () => {
    let ws = initWorkspace(list(0))
    for (let i = 1; i < MAX_TABS + 3; i++) ws = openTab(ws, list(i))
    expect(ws.tabs).toHaveLength(MAX_TABS)
  })

  it('closes a tab and lands on its right neighbour, or the new last tab', () => {
    let ws = initWorkspace(list(1))
    ws = openTab(ws, list(2))
    ws = openTab(ws, list(3))
    ws = selectTab(ws, 1)
    let next = closeTab(ws)!
    expect(currentView(next).folderId).toBe(3)
    next = closeTab(selectTab(ws, 2))!
    expect(currentView(next).folderId).toBe(2)
    // Closing a tab left of the active one keeps the same tab active.
    next = closeTab(selectTab(ws, 2), 0)!
    expect(currentView(next).folderId).toBe(3)
    expect(closeTab(initWorkspace(list(1)))).toBeNull()
  })

  it('selects by number with ⌘9 as the last tab, and cycles both ways', () => {
    let ws = initWorkspace(list(1))
    ws = openTab(ws, list(2))
    ws = openTab(ws, list(3))
    expect(selectTab(ws, 0).active).toBe(0)
    expect(selectTab(ws, 8).active).toBe(2)
    expect(selectTab(ws, 5)).toBe(ws)
    expect(cycleTab(ws, 1).active).toBe(0)
    expect(cycleTab(selectTab(ws, 0), -1).active).toBe(2)
  })
})

describe('persistence', () => {
  it('round-trips, dropping views that no longer exist', () => {
    let ws = initWorkspace(list(1))
    ws = navigate(ws, list(2))
    ws = openTab(ws, list(7))
    const json = serializeWorkspace(ws)
    const back1 = restoreWorkspace(json, (v) => v.folderId !== 7, list(1))
    expect(back1.tabs).toHaveLength(1)
    expect(back1.tabs[0].history).toEqual([list(1), list(2)])
    expect(back1.active).toBe(0)
    expect(restoreWorkspace(json, () => true, list(1))).toEqual(ws)
  })

  it('falls back to one tab on the fallback view for missing or corrupt data', () => {
    expect(restoreWorkspace(undefined, () => true, list(4))).toEqual(initWorkspace(list(4)))
    expect(restoreWorkspace('{"tabs":5}', () => true, list(4))).toEqual(initWorkspace(list(4)))
    expect(restoreWorkspace('nope', () => true, list(4))).toEqual(initWorkspace(list(4)))
  })

  it('keeps each account\'s tabs across ⌃1 → ⌃2 → ⌃1', () => {
    const settings: Record<string, string> = {}
    // Boot as account 1: its folders are 1..9; account 2 owns 11..19.
    const valid1 = (v: View) => v.folderId < 10
    const valid2 = (v: View) => v.folderId > 10
    let ws1 = restoreWorkspace(savedWorkspace(settings, 1), valid1, list(1))
    ws1 = navigate(ws1, list(2))
    ws1 = openTab(ws1, list(3))
    settings[workspaceKey(1)] = serializeWorkspace(ws1)
    // ⌃2 reloads as account 2, which falls back and saves under its own key.
    const ws2 = restoreWorkspace(savedWorkspace(settings, 2), valid2, list(11))
    expect(ws2).toEqual(initWorkspace(list(11)))
    settings[workspaceKey(2)] = serializeWorkspace(ws2)
    // ⌃1 again: account 1's tabs and history are intact.
    expect(restoreWorkspace(savedWorkspace(settings, 1), valid1, list(1))).toEqual(ws1)
  })

  it('seeds an account from the old global key only until it has its own', () => {
    const old = serializeWorkspace(openTab(initWorkspace(list(1)), list(2)))
    expect(savedWorkspace({ workspace: old }, 1)).toBe(old)
    expect(savedWorkspace({ workspace: old, [workspaceKey(1)]: 'mine' }, 1)).toBe('mine')
    expect(workspaceKey(null)).toBe('workspace')
  })
})
