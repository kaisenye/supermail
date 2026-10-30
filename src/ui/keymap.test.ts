import { describe, expect, it } from 'vitest'
import { buildChords, COMMANDS, type Command } from './commands.js'
import { applyKeymap, isRemappable, keymapConflicts, parseKeymap, specFromEvent } from './keymap.js'

const find = (id: string) => COMMANDS.find((c) => c.id === id)!

describe('remappable shortcuts', () => {
  it('starts from a registry with no conflicts', () => {
    expect(keymapConflicts(COMMANDS)).toEqual([])
  })

  it('reads only known commands and well-formed keys', () => {
    expect(
      parseKeymap(
        '{"msg.done":{"kind":"key","key":"y"},"nope":{"kind":"key","key":"q"},"msg.star":{"kind":"seq"},"msg.read":{"kind":"mod","key":"j","shift":true}}'
      )
    ).toEqual({
      'msg.done': { kind: 'key', key: 'y' },
      'msg.read': { kind: 'mod', key: 'j', shift: true }
    })
    expect(parseKeymap('not json')).toEqual({})
    expect(parseKeymap('[1]')).toEqual({})
    expect(parseKeymap(undefined)).toEqual({})
  })

  it('drops a stored override that clashes, keeping the rest', () => {
    // s is Star's default key; a hand edit (or a later default) put Done there too.
    const map = parseKeymap('{"msg.done":{"kind":"key","key":"s"},"msg.vip":{"kind":"key","key":"y"}}')
    expect(map).toEqual({ 'msg.vip': { kind: 'key', key: 'y' } })
    expect(keymapConflicts(applyKeymap(COMMANDS, map))).toEqual([])
  })

  it('replaces the primary key and keeps its modes and any second key', () => {
    const cmds: Command[] = [
      {
        id: 'thread.replyAll',
        title: 'Reply all',
        group: 'In a thread',
        keys: [
          { kind: 'key', key: 'R', modes: ['thread'] },
          { kind: 'key', key: 'Q', modes: ['thread'] }
        ]
      }
    ]
    expect(applyKeymap(cmds, { 'thread.replyAll': { kind: 'key', key: 'a' } })[0].keys).toEqual([
      { kind: 'key', key: 'a', modes: ['thread'] },
      { kind: 'key', key: 'Q', modes: ['thread'] }
    ])
  })

  it('gives a keyless command list-and-thread modes when it gets a single key', () => {
    const vip = applyKeymap(COMMANDS, { 'msg.vip': { kind: 'key', key: 'V' } }).find(
      (c) => c.id === 'msg.vip'
    )!
    expect(vip.keys).toEqual([{ kind: 'key', key: 'V', modes: ['list', 'thread'] }])
  })

  it('keeps a keyless command out of compose and modals when it gets a ⌘ chord', () => {
    const cmds = applyKeymap(COMMANDS, { 'msg.vip': { kind: 'mod', key: 'j' } })
    expect(cmds.find((c) => c.id === 'msg.vip')!.keys).toEqual([{ kind: 'mod', key: 'j', modes: ['list', 'thread'] }])
    const handlers = { 'msg.vip': () => {} }
    expect(buildChords('compose', handlers, cmds)).toEqual([])
    expect(buildChords('modal', handlers, cmds)).toEqual([])
    expect(buildChords('list', handlers, cmds)).toHaveLength(1)
  })

  it('refuses a ⌘ chord the system or the app menu owns', () => {
    for (const spec of [
      { kind: 'mod', key: 'v' },
      { kind: 'mod', key: 'c' },
      { kind: 'mod', key: 'q' },
      { kind: 'mod', key: 'z', shift: true },
      { kind: 'mod', key: 'w', shift: true },
      { kind: 'mod', key: 'a' }
    ] as const) {
      const cmds = applyKeymap(COMMANDS, { 'msg.done': spec })
      expect(keymapConflicts(cmds).join('\n')).toMatch(/Done: .* is reserved by the system/)
    }
    expect(keymapConflicts(applyKeymap(COMMANDS, { 'palette.open': { kind: 'mod', key: 'v' } })).join('\n')).toMatch(
      /reserved/
    )
    // ⌘W is not reserved: the menu leaves it to Close tab, its only conflict. ⇧⌘V is not a menu chord.
    expect(keymapConflicts(applyKeymap(COMMANDS, { 'msg.done': { kind: 'mod', key: 'w' } }))).toEqual([
      'Close tab and Done both use ⌘W (list)',
      'Close tab and Done both use ⌘W (thread)'
    ])
    expect(keymapConflicts(applyKeymap(COMMANDS, { 'msg.done': { kind: 'mod', key: 'v', shift: true } }))).toEqual([])
  })

  it('reports a key two commands would share in one mode', () => {
    const cmds = applyKeymap(COMMANDS, { 'msg.done': { kind: 'key', key: 's' } })
    expect(keymapConflicts(cmds).join('\n')).toMatch(/Star and Done|Done and Star/)
  })

  it('refuses a single key that starts a g sequence', () => {
    const cmds = applyKeymap(COMMANDS, { 'msg.done': { kind: 'key', key: 'g' } })
    expect(keymapConflicts(cmds).join('\n')).toMatch(/sequence/)
  })

  it('does not remap compose-editor keys, sequences or the numbered families', () => {
    expect(isRemappable(find('compose.send'))).toBe(false)
    expect(isRemappable(find('go.inbox'))).toBe(false)
    expect(isRemappable(find('account.1'))).toBe(false)
    expect(isRemappable(find('account.2'))).toBe(false)
    expect(isRemappable(find('msg.vip'))).toBe(true)
    expect(isRemappable(find('msg.done'))).toBe(true)
  })

  it('reads a recorded key press', () => {
    const ev = (key: string, o: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...o
    })
    expect(specFromEvent(ev('y'))).toEqual({ kind: 'key', key: 'y' })
    expect(specFromEvent(ev('Y', { shiftKey: true }))).toEqual({ kind: 'key', key: 'Y' })
    expect(specFromEvent(ev('Tab', { shiftKey: true }))).toEqual({ kind: 'key', key: 'Shift+Tab' })
    expect(specFromEvent(ev('J', { metaKey: true, shiftKey: true }))).toEqual({ kind: 'mod', key: 'j', shift: true })
    expect(specFromEvent(ev('k', { metaKey: true }))).toEqual({ kind: 'mod', key: 'k' })
    expect(specFromEvent(ev('Shift', { shiftKey: true }))).toBeNull()
    expect(specFromEvent(ev('x', { altKey: true }))).toBeNull()
    expect(specFromEvent(ev('1', { ctrlKey: true }))).toBeNull()
    expect(specFromEvent(ev('Escape'))).toBeNull()
  })
})
