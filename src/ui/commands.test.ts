import { describe, expect, it } from 'vitest'
import type { Mode } from './hooks/useHotkeys.js'
import {
  COMMANDS,
  buildBindings,
  buildChords,
  buildPaletteActions,
  buildSequences,
  keyCaps,
  shortcutGroups
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

  it('never reuses a ⌘ chord or a sequence', () => {
    const chords = COMMANDS.flatMap((c) => c.keys.filter((k) => k.kind === 'mod').map((k) => k.key))
    expect(new Set(chords).size).toBe(chords.length)
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
})
