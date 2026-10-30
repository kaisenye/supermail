import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { appMode, baseMode } from './appMode'
import { buildBindings, buildChords, buildPaletteActions, buildSequences, type Handlers } from './commands'

const none = { compose: false, tasksOpen: false, openThread: false, overlayOpen: false }

describe('appMode', () => {
  it('keeps list keys off while Tasks replaces the mail pane', () => {
    expect(appMode({ ...none, tasksOpen: true })).toBe('modal')
    const h: Handlers = { 'msg.done': () => {}, 'msg.spam': () => {}, 'split.next': () => {}, 'select.all': () => {} }
    const mode = appMode({ ...none, tasksOpen: true })
    expect(buildBindings(mode, h).filter((b) => !b.modes || b.modes.includes(mode))).toEqual([])
    expect(buildChords(mode, h)).toEqual([])
    expect(buildSequences(mode, { 'go.inbox': () => {} })).toEqual({})
  })

  it('reads list, thread and compose as before', () => {
    expect(appMode(none)).toBe('list')
    expect(appMode({ ...none, openThread: true })).toBe('thread')
    expect(appMode({ ...none, compose: true, openThread: true })).toBe('compose')
    expect(appMode({ ...none, openThread: true, overlayOpen: true })).toBe('modal')
  })
})

describe('palette mode', () => {
  it('passes the thread underneath ⌘K to its commands, not modal', () => {
    // ⌘K open over a thread: the keyboard mode is modal, the palette's base is thread.
    expect(appMode({ ...none, openThread: true, overlayOpen: true })).toBe('modal')
    expect(baseMode({ ...none, openThread: true })).toBe('thread')
    const seen: string[] = []
    const actions = buildPaletteActions(baseMode({ ...none, openThread: true }), {
      'msg.done': ({ mode }) => void seen.push(mode)
    })
    actions.find((a) => a.id === 'msg.done')?.run()
    expect(seen).toEqual(['thread'])
  })

  it('leaves out mail commands over Tasks', () => {
    const h: Handlers = { 'msg.done': () => {}, 'filter.unread': () => {}, 'go.inbox': () => {} }
    const ids = buildPaletteActions(baseMode({ ...none, tasksOpen: true }), h).map((a) => a.id)
    expect(ids).toEqual(['go.inbox'])
  })
})

describe('App wiring', () => {
  const app = readFileSync(join(__dirname, 'App.tsx'), 'utf8')
  it('derives the keyboard mode with Tasks and builds the palette from the base mode', () => {
    expect(app).toContain('tasksOpen, openThread: !!openThread }')
    expect(app).toContain('appMode({')
    expect(app).toContain('buildPaletteActions(paletteMode, handlers)')
    expect(app).not.toContain('buildPaletteActions(mode,')
  })
  it('routes g e through the provider-aware Done target', () => {
    expect(app).toContain('goDoneTarget(useStore.getState().folders, acct?.provider)')
    expect(app).not.toContain("gotoFolder('archive')")
  })
})
