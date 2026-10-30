import { describe, expect, it, vi } from 'vitest'
import { eventKey, type Mode } from './hooks/useHotkeys.js'
import { matchChord } from './hooks/useCommandChord.js'
import {
  COMMANDS,
  buildBindings,
  buildChords,
  buildPaletteActions,
  buildSequences,
  keyCaps,
  shortcutGroups,
  withTiming
} from './commands.js'

const ALL_MODES: Mode[] = ['list', 'thread', 'compose', 'modal']

describe('command registry', () => {
  it('never binds one key twice in the same mode', () => {
    const seen = new Map<string, string>()
    for (const c of COMMANDS) {
      for (const k of c.keys) {
        if (k.kind !== 'key') continue
        for (const m of k.modes ?? ALL_MODES) {
          const slot = `${m}:${k.key}`
          expect(seen.get(slot), `${slot} is bound by ${seen.get(slot)} and ${c.id}`).toBeUndefined()
          seen.set(slot, c.id)
        }
      }
    }
  })

  it('never reuses a ⌘ chord in the same mode, or a sequence', () => {
    const seen = new Map<string, string>()
    for (const c of COMMANDS) {
      for (const k of c.keys) {
        if (k.kind !== 'mod') continue
        for (const m of k.modes ?? ALL_MODES) {
          const slot = `${m}:${k.shift ? '⇧' : ''}${k.key.toLowerCase()}`
          expect(seen.get(slot), `${slot} is bound by ${seen.get(slot)} and ${c.id}`).toBeUndefined()
          seen.set(slot, c.id)
        }
      }
    }
    const seqs = COMMANDS.flatMap((c) =>
      c.keys.flatMap((k) => (k.kind === 'seq' ? [k.keys.join(' ')] : []))
    )
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('never makes a sequence prefix a single-key binding', () => {
    const singles = new Set(
      COMMANDS.flatMap((c) => c.keys.flatMap((k) => (k.kind === 'key' ? [k.key] : [])))
    )
    for (const c of COMMANDS)
      for (const k of c.keys) if (k.kind === 'seq') expect(singles.has(k.keys[0])).toBe(false)
  })

  it('draws keycaps the way the sheet shows them', () => {
    expect(keyCaps({ kind: 'key', key: 'R' })).toEqual(['⇧', 'R'])
    expect(keyCaps({ kind: 'key', key: 'Backspace' })).toEqual(['⌫'])
    expect(keyCaps({ kind: 'mod', key: 'k' })).toEqual(['⌘', 'K'])
    expect(keyCaps({ kind: 'seq', keys: ['g', 'i'] })).toEqual(['g', 'i'])
    expect(keyCaps({ kind: 'mod', key: 'h', shift: true })).toEqual(['⌘', '⇧', 'H'])
    expect(keyCaps({ kind: 'key', key: 'Tab' })).toEqual(['⇥'])
    expect(keyCaps({ kind: 'key', key: 'Shift+Tab' })).toEqual(['⇧', '⇥'])
  })

  it('tells Shift+Tab apart from Tab', () => {
    expect(eventKey({ key: 'Tab', shiftKey: true })).toBe('Shift+Tab')
    expect(eventKey({ key: 'Tab', shiftKey: false })).toBe('Tab')
    expect(eventKey({ key: 'E', shiftKey: true })).toBe('E')
  })

  it('binds z to undo in the list and in a thread', () => {
    const [b] = buildBindings('list', { undo: () => {} })
    expect([b.key, b.modes]).toEqual(['z', ['list', 'thread']])
  })

  it('binds e, E and ! to Done, Not done and Spam, and g e to the Done folder', () => {
    const h = { 'msg.done': () => {}, 'msg.notDone': () => {}, 'msg.spam': () => {}, 'go.done': () => {} }
    expect(buildBindings('thread', h).map((b) => b.key)).toEqual(['e', 'E', '!'])
    expect(Object.keys(buildSequences('list', h).g ?? {})).toEqual(['e'])
  })

  it('binds split, chip, grouping and selection keys in the list only', () => {
    const h = {
      'split.next': () => {},
      'split.prev': () => {},
      'filter.unread': () => {},
      'filter.needsReply': () => {},
      'filter.waiting': () => {},
      'filter.starred': () => {},
      'list.groupByDate': () => {},
      'select.all': () => {},
      'select.extendDown': () => {},
      'select.extendUp': () => {}
    }
    expect(buildBindings('list', h).map((b) => [b.key, b.modes])).toEqual([
      ['Tab', ['list']],
      ['Shift+Tab', ['list']],
      ['U', ['list']],
      ['R', ['list']],
      ['S', ['list']],
      ['D', ['list']],
      ['J', ['list']],
      ['K', ['list']]
    ])
    expect(buildChords('list', h).map((c) => c.key)).toEqual(['a'])
    expect(buildChords('thread', h)).toEqual([])
    // Waiting has no key; it is reached from ⌘K or its chip.
    expect(buildPaletteActions('list', h).map((a) => a.id)).toContain('filter.waiting')
  })

  it('binds h to Remind me, g h to Reminders, and ⌘⇧H in compose only', () => {
    const h = { 'msg.remind': () => {}, 'go.reminders': () => {}, 'compose.remind': () => {} }
    expect(buildBindings('thread', h).map((b) => [b.key, b.modes])).toEqual([['h', ['list', 'thread']]])
    expect(Object.keys(buildSequences('list', h).g ?? {})).toEqual(['h'])
    // Compose owns ⌘⇧H itself, so it never binds globally.
    expect(buildChords('list', h)).toEqual([])
    const remind = COMMANDS.find((c) => c.id === 'compose.remind')
    expect(remind?.keys).toEqual([{ kind: 'mod', key: 'h', shift: true, modes: ['compose'] }])
    expect(buildPaletteActions('list', h).map((a) => a.id)).toEqual(['go.reminders', 'msg.remind'])
  })

  it('binds v, l and M to Move, Label and Mute; VIP is ⌘K only', () => {
    const h = { 'msg.move': () => {}, 'msg.label': () => {}, 'msg.mute': () => {}, 'msg.vip': () => {} }
    expect(buildBindings('thread', h).map((b) => [b.key, b.modes])).toEqual([
      ['v', ['list', 'thread']],
      ['l', ['list', 'thread']],
      ['M', ['list', 'thread']]
    ])
    expect(buildPaletteActions('list', h).map((a) => a.id)).toEqual(
      expect.arrayContaining(['msg.move', 'msg.label', 'msg.mute', 'msg.vip'])
    )
  })

  it('leaves ⌘A to a text field, so it still selects the text there', () => {
    const chords = buildChords('list', { 'select.all': () => {}, 'palette.open': () => {} })
    const key = (k: string) => ({ key: k, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })
    expect(matchChord(chords, key('a'), false)?.key).toBe('a')
    expect(matchChord(chords, key('a'), true)).toBeUndefined()
    expect(matchChord(chords, key('k'), true)?.key).toBe('k')
  })

  it('binds single keys only for commands that have a handler, passing the mode', () => {
    const seen: Mode[] = []
    const bindings = buildBindings('thread', { 'msg.star': ({ mode }) => void seen.push(mode) })
    expect(bindings.map((b) => b.key)).toEqual(['s'])
    // Node has no KeyboardEvent, and the builder's handlers ignore the event.
    bindings[0].handler({} as KeyboardEvent)
    expect(seen).toEqual(['thread'])
  })

  it('never binds compose-editor shortcuts globally', () => {
    const chords = buildChords('list', { 'compose.send': () => {}, 'format.bold': () => {} })
    expect(chords).toEqual([])
  })

  it('offers sequences only in the modes they allow', () => {
    const h = { 'go.inbox': () => {} }
    expect(Object.keys(buildSequences('list', h).g ?? {})).toEqual(['i'])
    expect(buildSequences('thread', h)).toEqual({})
  })

  it('lists palette commands with their shortcut as a hint', () => {
    const actions = buildPaletteActions('modal', { 'go.inbox': () => {}, 'nav.down': () => {} })
    expect(actions.map((a) => [a.id, a.hint])).toEqual([['go.inbox', 'g i']])
  })

  it('puts sequences on the sheet as "then" rows', () => {
    const nav = shortcutGroups().find((g) => g.title === 'Navigation')!
    expect(nav.items.find((i) => i.label === 'Go to Inbox')).toEqual({
      label: 'Go to Inbox',
      keys: ['g', 'i'],
      then: true,
      alt: undefined
    })
  })

  it('keeps ⌘U for Unsubscribe in the list and for Underline in compose', () => {
    const h = { 'msg.unsubscribe': () => {} }
    expect(buildChords('list', h).map((c) => c.key)).toEqual(['u'])
    expect(buildChords('compose', h)).toEqual([])
  })
})

describe('withTiming', () => {
  it('logs, instead of rejecting, when a handler throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const wrapped = withTiming({
        'nav.down': () => {
          throw new Error('x')
        }
      })
      await expect(wrapped['nav.down']!({ mode: 'list' })).resolves.toBeUndefined()
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
