import type { Binding, Mode } from './hooks/useHotkeys'
import type { PaletteAction } from './views/CommandPalette'
import { timed } from './perf'

/**
 * Every user action, declared once. Hotkeys, ⌘ chords, g-sequences, the ⌘K
 * palette and the shortcut sheet are all built from this list, so a shortcut
 * can never work in one place and be missing from another.
 */

export type KeySpec =
  /** A bare key as KeyboardEvent.key reports it: 'j', 'Enter', 'R' (shifted). */
  | { kind: 'key'; key: string; modes?: Mode[] }
  /** Two keys in a row, e.g. g then i. */
  | { kind: 'seq'; keys: [string, string]; modes?: Mode[] }
  /** ⌘ (Ctrl off macOS) plus a key. Live in every mode; handlers decide. */
  | { kind: 'mod'; key: string }

export type Group = 'General' | 'Navigation' | 'Message' | 'In a thread' | 'Compose'

export type CommandId =
  | 'palette.open'
  | 'compose.new'
  | 'settings.open'
  | 'shortcuts.open'
  | 'escape'
  | 'sync.now'
  | 'account.add'
  | 'nav.down'
  | 'nav.up'
  | 'nav.open'
  | 'go.inbox'
  | 'go.sent'
  | 'go.drafts'
  | 'go.trash'
  | 'go.junk'
  | 'msg.star'
  | 'msg.read'
  | 'msg.trash'
  | 'msg.select'
  | 'thread.reply'
  | 'thread.replyAll'
  | 'thread.forward'
  | 'compose.send'
  | 'format.bold'
  | 'format.italic'
  | 'format.underline'

export interface Command {
  id: CommandId
  title: string
  group: Group
  /** First is the primary shortcut; a second shows as "or" on the sheet. */
  keys: KeySpec[]
  /** Offer it in ⌘K. */
  palette?: boolean
  /** Bound by another component (the compose editor); listed on the sheet only. */
  external?: boolean
}

const LIST_THREAD: Mode[] = ['list', 'thread']

export const COMMANDS: Command[] = [
  {
    id: 'palette.open',
    title: 'Search and command menu',
    group: 'General',
    keys: [{ kind: 'mod', key: 'k' }, { kind: 'key', key: '/', modes: LIST_THREAD }]
  },
  {
    id: 'compose.new',
    title: 'Compose new message',
    group: 'General',
    palette: true,
    keys: [{ kind: 'key', key: 'c', modes: LIST_THREAD }]
  },
  { id: 'settings.open', title: 'Settings', group: 'General', palette: true, keys: [{ kind: 'mod', key: ',' }] },
  {
    id: 'shortcuts.open',
    title: 'Keyboard shortcuts',
    group: 'General',
    palette: true,
    keys: [{ kind: 'mod', key: '.' }]
  },
  {
    id: 'escape',
    title: 'Close · clear selection · go back',
    group: 'General',
    keys: [{ kind: 'key', key: 'Escape', modes: LIST_THREAD }]
  },
  { id: 'sync.now', title: 'Sync now', group: 'General', palette: true, keys: [] },
  { id: 'account.add', title: 'Add mailbox…', group: 'General', palette: true, keys: [] },

  { id: 'nav.down', title: 'Move down', group: 'Navigation', keys: [{ kind: 'key', key: 'j', modes: ['list'] }] },
  { id: 'nav.up', title: 'Move up', group: 'Navigation', keys: [{ kind: 'key', key: 'k', modes: ['list'] }] },
  { id: 'nav.open', title: 'Open message', group: 'Navigation', keys: [{ kind: 'key', key: 'Enter', modes: ['list'] }] },
  { id: 'go.inbox', title: 'Go to Inbox', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 'i'], modes: ['list'] }] },
  { id: 'go.sent', title: 'Go to Sent', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 's'], modes: ['list'] }] },
  { id: 'go.drafts', title: 'Go to Drafts', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 'd'], modes: ['list'] }] },
  { id: 'go.trash', title: 'Go to Trash', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 't'], modes: ['list'] }] },
  { id: 'go.junk', title: 'Go to Junk', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 'j'], modes: ['list'] }] },

  { id: 'msg.star', title: 'Star', group: 'Message', keys: [{ kind: 'key', key: 's', modes: LIST_THREAD }] },
  { id: 'msg.read', title: 'Toggle read / unread', group: 'Message', keys: [{ kind: 'key', key: 'u', modes: LIST_THREAD }] },
  // The Mac key labelled "delete" reports as Backspace.
  { id: 'msg.trash', title: 'Trash', group: 'Message', keys: [{ kind: 'key', key: 'Backspace', modes: LIST_THREAD }] },
  { id: 'msg.select', title: 'Select', group: 'Message', keys: [{ kind: 'key', key: 'x', modes: ['list'] }] },

  { id: 'thread.reply', title: 'Reply', group: 'In a thread', keys: [{ kind: 'key', key: 'r', modes: ['thread'] }] },
  { id: 'thread.replyAll', title: 'Reply all', group: 'In a thread', keys: [{ kind: 'key', key: 'R', modes: ['thread'] }] },
  { id: 'thread.forward', title: 'Forward', group: 'In a thread', keys: [{ kind: 'key', key: 'f', modes: ['thread'] }] },

  { id: 'compose.send', title: 'Send', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'Enter' }] },
  { id: 'format.bold', title: 'Bold', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'b' }] },
  { id: 'format.italic', title: 'Italic', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'i' }] },
  { id: 'format.underline', title: 'Underline', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'u' }] }
]

export type Handler = (ctx: { mode: Mode }) => void | Promise<unknown>
export type Handlers = Partial<Record<CommandId, Handler>>

const NAMED: Record<string, string> = {
  Backspace: '⌫',
  Enter: '↵',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓'
}

const cap = (k: string): string => NAMED[k] ?? k

export function keyCaps(spec: KeySpec): string[] {
  if (spec.kind === 'seq') return spec.keys.map(cap)
  if (spec.kind === 'mod') return ['⌘', cap(spec.key).toUpperCase()]
  const k = spec.key
  // A shifted letter arrives as its capital (R); show the Shift it took.
  if (k.length === 1 && k !== k.toLowerCase()) return ['⇧', k]
  return [cap(k)]
}

function hint(spec: KeySpec): string {
  return keyCaps(spec).join(spec.kind === 'seq' ? ' ' : '')
}

/** Commands this component actually handles. */
function live(handlers: Handlers): { cmd: Command; run: Handler }[] {
  return COMMANDS.flatMap((cmd) => {
    const run = handlers[cmd.id]
    return run && !cmd.external ? [{ cmd, run }] : []
  })
}

export function buildBindings(mode: Mode, handlers: Handlers): Binding[] {
  return live(handlers).flatMap(({ cmd, run }) =>
    cmd.keys.flatMap((k) =>
      k.kind === 'key'
        ? [{ key: k.key, modes: k.modes, handler: () => void run({ mode }) }]
        : []
    )
  )
}

export function buildChords(
  mode: Mode,
  handlers: Handlers
): { key: string; handler: () => void }[] {
  return live(handlers).flatMap(({ cmd, run }) =>
    cmd.keys.flatMap((k) =>
      k.kind === 'mod' ? [{ key: k.key, handler: () => void run({ mode }) }] : []
    )
  )
}

/** First key -> second key -> action, for the sequences allowed in `mode`. */
export function buildSequences(
  mode: Mode,
  handlers: Handlers
): Record<string, Record<string, () => void>> {
  const out: Record<string, Record<string, () => void>> = {}
  for (const { cmd, run } of live(handlers)) {
    for (const k of cmd.keys) {
      if (k.kind !== 'seq' || (k.modes && !k.modes.includes(mode))) continue
      const [first, second] = k.keys
      ;(out[first] ??= {})[second] = () => void run({ mode })
    }
  }
  return out
}

export function buildPaletteActions(mode: Mode, handlers: Handlers): PaletteAction[] {
  return live(handlers)
    .filter(({ cmd }) => cmd.palette)
    .map(({ cmd, run }) => ({
      id: cmd.id,
      label: cmd.title,
      hint: cmd.keys[0] ? hint(cmd.keys[0]) : undefined,
      run: () => void run({ mode })
    }))
}

/** Wraps every handler in the 100ms speed budget. */
export function withTiming(handlers: Handlers): Handlers {
  const out: Handlers = {}
  for (const [id, h] of Object.entries(handlers) as [CommandId, Handler][]) {
    out[id] = (ctx) => timed(id, () => h(ctx))
  }
  return out
}

export interface SheetRow {
  label: string
  /** Rendered as separate keycaps; `then` marks a sequence. */
  keys: string[]
  then?: boolean
  /** Equivalent binding, shown after "or". */
  alt?: string[]
}

const GROUP_ORDER: Group[] = ['General', 'Navigation', 'Message', 'In a thread', 'Compose']

export function shortcutGroups(): { title: Group; items: SheetRow[] }[] {
  return GROUP_ORDER.map((title) => ({
    title,
    items: COMMANDS.filter((c) => c.group === title && c.keys.length > 0).map((c) => ({
      label: c.title,
      keys: keyCaps(c.keys[0]),
      then: c.keys[0].kind === 'seq' || undefined,
      alt: c.keys[1] ? keyCaps(c.keys[1]) : undefined
    }))
  })).filter((g) => g.items.length > 0)
}
