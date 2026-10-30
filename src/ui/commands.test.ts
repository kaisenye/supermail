import { describe, expect, it, vi } from 'vitest'
import { eventKey, MODES, type Mode } from './hooks/useHotkeys.js'
import { matchChord } from './hooks/useCommandChord.js'
import {
  COMMANDS,
  buildBindings,
  buildChords,
  buildPaletteActions,
  buildSequences,
  keyCaps,
  shortcutGroups,
  withTiming,
  type Handlers
} from './commands.js'

const ALL_MODES: Mode[] = MODES

describe('command registry', () => {
  it('never reuses a ⌃ chord in the same mode', () => {
    const seen = new Map<string, string>()
    for (const c of COMMANDS) {
      for (const k of c.keys) {
        if (k.kind !== 'ctrl') continue
        for (const m of k.modes ?? ALL_MODES) {
          const slot = `${m}:${k.shift ? '⇧' : ''}${k.key.toLowerCase()}`
          expect(seen.get(slot), `${slot} is bound by ${seen.get(slot)} and ${c.id}`).toBeUndefined()
          seen.set(slot, c.id)
        }
      }
    }
  })

  it('switches accounts on ⌃1–⌃9, never on ⌘, and not while composing', () => {
    const h = { 'account.1': () => {}, 'account.9': () => {} } as Handlers
    const chords = buildChords('list', h)
    const ev = (key: string, metaKey: boolean, ctrlKey: boolean) => ({
      key,
      metaKey,
      ctrlKey,
      altKey: false,
      shiftKey: false
    })
    expect(matchChord(chords, ev('1', false, true), false)?.key).toBe('1')
    expect(matchChord(chords, ev('9', false, true), true)?.key).toBe('9')
    expect(matchChord(chords, ev('1', true, false), false)).toBeUndefined()
    expect(buildChords('compose', h)).toEqual([])
  })

  it('lets a ⌃ chord win over a ⌘ chord on the same key', () => {
    const ran: string[] = []
    const chords = [
      { key: '1', handler: () => void ran.push('mod') },
      { key: '1', ctrl: true, handler: () => void ran.push('ctrl') }
    ]
    const ev = { key: '1', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }
    matchChord(chords, ev, false)?.handler({} as KeyboardEvent)
    matchChord(chords, { ...ev, metaKey: true, ctrlKey: false }, false)?.handler({} as KeyboardEvent)
    expect(ran).toEqual(['ctrl', 'mod'])
  })

  it('draws ⌃ keycaps and lists the account keys as one sheet row', () => {
    expect(keyCaps({ kind: 'ctrl', key: 'Tab', shift: true })).toEqual(['⌃', '⇧', '⇥'])
    expect(keyCaps({ kind: 'ctrl', key: '1' })).toEqual(['⌃', '1'])
    const general = shortcutGroups().find((g) => g.title === 'General')!
    expect(general.items.filter((i) => i.label.startsWith('Switch to account'))).toEqual([
      { label: 'Switch to account 1–9', keys: ['⌃', '1–9'] }
    ])
  })

  it('builds from any command list, so a keymap can replace keys', () => {
    const only = COMMANDS.filter((c) => c.id === 'msg.star').map((c) => ({
      ...c,
      keys: [{ kind: 'key' as const, key: 'y', modes: ['list' as const] }]
    }))
    expect(buildBindings('list', { 'msg.star': () => {} }, only).map((b) => b.key)).toEqual(['y'])
    expect(shortcutGroups(only).flatMap((g) => g.items.map((i) => i.keys))).toEqual([['y']])
  })

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

  it('binds g a to the unified inbox', () => {
    expect(Object.keys(buildSequences('list', { 'go.unified': () => {} }).g ?? {})).toEqual(['a'])
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

  it('binds tab and history chords in the list and a thread, not while composing', () => {
    const h = {
      'tab.new': () => {},
      'tab.close': () => {},
      'tab.next': () => {},
      'tab.prev': () => {},
      'tab.1': () => {},
      'tab.9': () => {},
      'history.back': () => {},
      'history.forward': () => {}
    } as Handlers
    expect(buildChords('thread', h).map((c) => [c.key, !!c.shift, !!c.ctrl])).toEqual([
      ['t', false, false],
      ['w', false, false],
      ['Tab', false, true],
      ['Tab', true, true],
      ['1', false, false],
      ['9', false, false],
      ['[', false, false],
      [']', false, false]
    ])
    expect(buildChords('compose', h)).toEqual([])
    const tabs = shortcutGroups().find((g) => g.title === 'Tabs')!
    expect(tabs.items.find((i) => i.label === 'Go to tab 1–9')).toEqual({ label: 'Go to tab 1–9', keys: ['⌘', '1–9'] })
  })

  it('gives a thread its reading keys, Enter as reply all, and ⌘O', () => {
    const ids = [
      'thread.replyAll',
      'thread.nextConv',
      'thread.prevConv',
      'thread.nextMsg',
      'thread.prevMsg',
      'thread.expand',
      'thread.expandAll',
      'thread.pageDown',
      'thread.pageUp',
      'thread.nextLink',
      'thread.prevLink'
    ]
    const h = Object.fromEntries(ids.map((id) => [id, () => {}])) as Handlers
    expect(buildBindings('thread', h).map((b) => [b.key, b.modes])).toEqual([
      ['Enter', ['thread']],
      ['R', ['thread']],
      ['j', ['thread']],
      ['k', ['thread']],
      ['n', ['thread']],
      ['p', ['thread']],
      ['o', ['thread']],
      ['O', ['thread']],
      ['Space', ['thread']],
      ['Shift+Space', ['thread']],
      ['Tab', ['thread']],
      ['Shift+Tab', ['thread']]
    ])
    expect(buildChords('thread', { 'thread.open': () => {} }).map((c) => c.key)).toEqual(['o'])
    expect(buildChords('list', { 'thread.open': () => {} })).toEqual([])
  })

  it('reads Space and Shift+Space as keys of their own', () => {
    expect(eventKey({ key: ' ', shiftKey: false })).toBe('Space')
    expect(eventKey({ key: ' ', shiftKey: true })).toBe('Shift+Space')
    expect(keyCaps({ kind: 'key', key: 'Space' })).toEqual(['Space'])
    expect(keyCaps({ kind: 'key', key: 'Shift+Space' })).toEqual(['⇧', 'Space'])
  })

  it('keeps ⌘U for Unsubscribe in the list and for Underline in compose', () => {
    const h = { 'msg.unsubscribe': () => {} }
    expect(buildChords('list', h).map((c) => c.key)).toEqual(['u'])
    expect(buildChords('compose', h)).toEqual([])
  })

  it('declares the new compose chords for the editor only', () => {
    const ids = [
      'compose.sendDone',
      'compose.sendLater',
      'compose.intro',
      'compose.focusTo',
      'compose.focusCc',
      'compose.focusBcc',
      'compose.focusSubject'
    ]
    for (const id of ids) {
      const c = COMMANDS.find((x) => x.id === id)!
      expect(c.external, id).toBe(true)
      expect(c.keys[0], id).toMatchObject({ kind: 'mod', shift: true, modes: ['compose'] })
    }
    const h = Object.fromEntries(ids.map((id) => [id, () => {}])) as Handlers
    expect(buildChords('compose', h)).toEqual([])
  })

  it('declares ⌘; as the compose snippet picker', () => {
    expect(COMMANDS.find((c) => c.id === 'compose.snippet')).toMatchObject({
      external: true,
      keys: [{ kind: 'mod', key: ';', modes: ['compose'] }]
    })
  })

  it('declares ⌘J in compose as an editor-owned chord', () => {
    const c = COMMANDS.find((x) => x.id === 'compose.ai')
    expect(c?.external).toBe(true)
    expect(c?.keys).toEqual([{ kind: 'mod', key: 'j', modes: ['compose'] }])
    expect(buildChords('list', { 'compose.ai': () => {} })).toEqual([])
  })

  it('offers Summarize conversation in ⌘K only', () => {
    const c = COMMANDS.find((x) => x.id === 'thread.summarize')
    expect(c?.keys).toEqual([])
    expect(buildPaletteActions('thread', { 'thread.summarize': () => {} }).map((a) => a.id)).toEqual(['thread.summarize'])
  })

  it('binds 1–3 to the Instant Replies in a thread only, shown as one sheet row', () => {
    const h = { 'reply.option1': () => {}, 'reply.option2': () => {}, 'reply.option3': () => {} }
    expect(buildBindings('thread', h).map((b) => [b.key, b.modes])).toEqual([
      ['1', ['thread']],
      ['2', ['thread']],
      ['3', ['thread']]
    ])
    expect(buildBindings('list', h).filter((b) => b.modes?.includes('list'))).toEqual([])
    const rows = shortcutGroups().find((g) => g.title === 'In a thread')!.items
    expect(rows.filter((r) => r.label.startsWith('Instant reply'))).toEqual([{ label: 'Instant reply 1–3', keys: ['1–3'] }])
  })

  it('opens Ask AI with ⌘J outside compose, and keeps ⌘J for Write with AI in compose', () => {
    const h = { 'ai.ask': () => {} }
    expect(buildChords('list', h).map((c) => c.key)).toEqual(['j'])
    expect(buildChords('search', h).map((c) => c.key)).toEqual(['j'])
    expect(buildChords('compose', h)).toEqual([])
    expect(buildPaletteActions('list', h)).toEqual([])
  })
})

describe('withTiming', () => {
  it('opens the search page on /, leaves ⌘K to the palette, and toggles the contact pane on i', () => {
    expect(COMMANDS.find((c) => c.id === 'palette.open')!.keys).toEqual([{ kind: 'mod', key: 'k' }])
    const h = { 'search.open': () => {}, 'thread.contactPane': () => {} }
    expect(buildBindings('list', h).map((b) => [b.key, b.modes])).toEqual([
      ['/', ['list', 'thread']],
      ['i', ['thread']]
    ])
    // Tabs and history work on the search page; Esc there goes back.
    expect(buildChords('search', { 'history.back': () => {} }).map((c) => c.key)).toEqual(['['])
    expect(buildBindings('search', { escape: () => {} })[0].modes).toContain('search')
  })

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
