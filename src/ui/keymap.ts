import { COMMANDS, keyCaps, type Command, type CommandId, type KeySpec } from './commands'
import { eventKey, MODES, type Mode } from './hooks/useHotkeys'

/** A user's replacement for a command's primary key. Sequences and ⌃ chords are not remappable. */
export type RemapSpec = { kind: 'key'; key: string } | { kind: 'mod'; key: string; shift?: boolean }
export type Keymap = Partial<Record<CommandId, RemapSpec>>

const IDS = new Set<string>(COMMANDS.map((c) => c.id))
const DEFAULT_KEY_MODES: Mode[] = ['list', 'thread']

/**
 * ⌘ chords the system or the app menu (electron/menu.ts) already own: edit
 * (⌘A ⌘C ⌘V ⌘X ⌘Z ⇧⌘Z), app (⌘H ⌘Q), window (⌘M ⇧⌘W), view (⌘R ⇧⌘R, zoom).
 * ⌘W is free on purpose; it closes a tab. ⌘A belongs to select.all in the list.
 */
const RESERVED_MOD = new Set(['a', 'c', 'v', 'x', 'z', '⇧z', 'h', 'q', 'm', '⇧w', 'r', '⇧r', '0', '-', '=', '+', '⇧+', '⇧='])

/**
 * Compose-editor chords belong to the editor, sequences and numbered families
 * come as a set, and everything else can take a new single key or ⌘ chord.
 */
export function isRemappable(c: Command): boolean {
  if (c.external || c.sheet !== undefined) return false
  const k = c.keys[0]
  return !k || k.kind === 'key' || k.kind === 'mod'
}

/** settings.keymap, tolerating anything a hand edit or an old build left there. */
export function parseKeymap(json: string | null | undefined): Keymap {
  if (!json) return {}
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Keymap = {}
  for (const [id, spec] of Object.entries(raw as Record<string, unknown>)) {
    if (!IDS.has(id)) continue
    const s = spec as { kind?: unknown; key?: unknown; shift?: unknown } | null
    if (!s || typeof s.key !== 'string' || !s.key) continue
    if (s.kind === 'key') out[id as CommandId] = { kind: 'key', key: s.key }
    else if (s.kind === 'mod')
      out[id as CommandId] = { kind: 'mod', key: s.key, ...(s.shift === true ? { shift: true } : {}) }
  }
  // An override that clashes (a hand edit, or a later build giving another
  // command that key by default) is dropped so the rest still applies, and the
  // recorder starts from a map with no conflicts.
  const kept: Keymap = {}
  for (const [id, spec] of Object.entries(out) as [CommandId, RemapSpec][]) {
    if (!keymapConflicts(applyKeymap(COMMANDS, { ...kept, [id]: spec })).length) kept[id] = spec
  }
  return kept
}

/**
 * Commands with each override in place of the primary key. The original
 * key's modes are kept, so a remapped list key stays a list key.
 */
export function applyKeymap(commands: Command[], map: Keymap): Command[] {
  return commands.map((c) => {
    const o = map[c.id]
    if (!o || !isRemappable(c)) return c
    // A keyless command acts on the mail on screen, so whatever key it gets lives in list and thread.
    const k = c.keys[0]
    const modes = k ? (k.modes ?? (o.kind === 'key' ? DEFAULT_KEY_MODES : undefined)) : DEFAULT_KEY_MODES
    const primary: KeySpec = { ...o, ...(modes ? { modes } : {}) }
    return { ...c, keys: [primary, ...c.keys.slice(1)] }
  })
}

/**
 * Every clash a keymap would create: one key for two commands in a mode, a key
 * that starts a g sequence, or a ⌘ chord the system or the app menu owns.
 */
export function keymapConflicts(commands: Command[]): string[] {
  const out: string[] = []
  const seen = new Map<string, Command>()
  const prefixes = new Set(commands.flatMap((c) => c.keys.flatMap((k) => (k.kind === 'seq' ? [k.keys[0]] : []))))
  for (const c of commands) {
    for (const k of c.keys) {
      if (k.kind === 'seq') continue
      if (k.kind === 'key' && prefixes.has(k.key)) out.push(`${c.title}: ${k.key} starts a g sequence`)
      const name = k.kind === 'key' ? k.key : `${k.shift ? '⇧' : ''}${k.key.toLowerCase()}`
      if (k.kind === 'mod' && RESERVED_MOD.has(name) && !(c.id === 'select.all' && name === 'a'))
        out.push(`${c.title}: ${keyCaps(k).join('')} is reserved by the system`)
      for (const m of k.modes ?? MODES) {
        const slot = `${k.kind}:${m}:${name}`
        const prev = seen.get(slot)
        if (prev && prev.id !== c.id) out.push(`${prev.title} and ${c.title} both use ${keyCaps(k).join('')} (${m})`)
        else seen.set(slot, c)
      }
    }
  }
  return [...new Set(out)]
}

type KeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/** The key a press would bind, or null for a bare modifier, ⌥, ⌃-only, or Escape (which cancels recording). */
export function specFromEvent(e: KeyEvent): RemapSpec | null {
  if (['Shift', 'Meta', 'Control', 'Alt', 'CapsLock'].includes(e.key)) return null
  if (e.altKey || e.key === 'Escape') return null
  if (e.ctrlKey && !e.metaKey) return null
  if (e.metaKey) {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    return { kind: 'mod', key, ...(e.shiftKey ? { shift: true } : {}) }
  }
  return { kind: 'key', key: eventKey(e) }
}
