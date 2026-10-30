import type { Binding, Mode } from './hooks/useHotkeys'
import type { Chord } from './hooks/useCommandChord'
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
  /** ⌘ (Ctrl off macOS) plus a key, optionally with Shift. Without `modes`, live in every mode. */
  | { kind: 'mod'; key: string; shift?: boolean; modes?: Mode[] }

export type Group = 'General' | 'Navigation' | 'Message' | 'List' | 'In a thread' | 'Compose'

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
  | 'go.done'
  | 'go.reminders'
  | 'msg.star'
  | 'msg.read'
  | 'msg.trash'
  | 'msg.done'
  | 'msg.notDone'
  | 'msg.spam'
  | 'msg.remind'
  | 'msg.move'
  | 'msg.label'
  | 'msg.mute'
  | 'msg.vip'
  | 'msg.unsubscribe'
  | 'msg.select'
  | 'undo'
  | 'triage.zero'
  | 'split.next'
  | 'split.prev'
  | 'filter.unread'
  | 'filter.needsReply'
  | 'filter.waiting'
  | 'filter.starred'
  | 'list.groupByDate'
  | 'select.all'
  | 'select.extendDown'
  | 'select.extendUp'
  | 'thread.reply'
  | 'thread.replyAll'
  | 'thread.forward'
  | 'compose.send'
  | 'compose.remind'
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
  { id: 'go.done', title: 'Go to Done', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 'e'], modes: ['list'] }] },
  { id: 'go.reminders', title: 'Go to Reminders', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 'h'], modes: ['list'] }] },

  { id: 'msg.star', title: 'Star', group: 'Message', keys: [{ kind: 'key', key: 's', modes: LIST_THREAD }] },
  { id: 'msg.read', title: 'Toggle read / unread', group: 'Message', keys: [{ kind: 'key', key: 'u', modes: LIST_THREAD }] },
  // The Mac key labelled "delete" reports as Backspace.
  { id: 'msg.trash', title: 'Trash', group: 'Message', keys: [{ kind: 'key', key: 'Backspace', modes: LIST_THREAD }] },
  { id: 'msg.done', title: 'Done', group: 'Message', palette: true, keys: [{ kind: 'key', key: 'e', modes: LIST_THREAD }] },
  { id: 'msg.notDone', title: 'Not done (back to Inbox)', group: 'Message', palette: true, keys: [{ kind: 'key', key: 'E', modes: LIST_THREAD }] },
  { id: 'msg.spam', title: 'Mark as spam', group: 'Message', palette: true, keys: [{ kind: 'key', key: '!', modes: LIST_THREAD }] },
  { id: 'msg.remind', title: 'Remind me', group: 'Message', palette: true, keys: [{ kind: 'key', key: 'h', modes: LIST_THREAD }] },
  { id: 'msg.move', title: 'Move to folder…', group: 'Message', palette: true, keys: [{ kind: 'key', key: 'v', modes: LIST_THREAD }] },
  { id: 'msg.label', title: 'Label… (Gmail)', group: 'Message', palette: true, keys: [{ kind: 'key', key: 'l', modes: LIST_THREAD }] },
  { id: 'msg.mute', title: 'Mute conversation', group: 'Message', palette: true, keys: [{ kind: 'key', key: 'M', modes: LIST_THREAD }] },
  { id: 'msg.vip', title: 'Toggle VIP sender', group: 'Message', palette: true, keys: [] },
  { id: 'msg.unsubscribe', title: 'Unsubscribe', group: 'Message', palette: true, keys: [{ kind: 'mod', key: 'u', modes: LIST_THREAD }] },
  { id: 'msg.select', title: 'Select', group: 'Message', keys: [{ kind: 'key', key: 'x', modes: ['list'] }] },
  { id: 'undo', title: 'Undo', group: 'Message', palette: true, keys: [{ kind: 'key', key: 'z', modes: LIST_THREAD }] },
  { id: 'triage.zero', title: 'Get me to zero…', group: 'General', palette: true, keys: [] },

  // R stays Reply all in a thread; a key may mean different things in different modes.
  { id: 'split.next', title: 'Next split', group: 'List', keys: [{ kind: 'key', key: 'Tab', modes: ['list'] }] },
  { id: 'split.prev', title: 'Previous split', group: 'List', keys: [{ kind: 'key', key: 'Shift+Tab', modes: ['list'] }] },
  { id: 'filter.unread', title: 'Filter: unread', group: 'List', palette: true, keys: [{ kind: 'key', key: 'U', modes: ['list'] }] },
  { id: 'filter.needsReply', title: 'Filter: needs reply', group: 'List', palette: true, keys: [{ kind: 'key', key: 'R', modes: ['list'] }] },
  { id: 'filter.waiting', title: 'Filter: waiting on others', group: 'List', palette: true, keys: [] },
  { id: 'filter.starred', title: 'Filter: starred', group: 'List', palette: true, keys: [{ kind: 'key', key: 'S', modes: ['list'] }] },
  { id: 'list.groupByDate', title: 'Group by date', group: 'List', palette: true, keys: [{ kind: 'key', key: 'D', modes: ['list'] }] },
  { id: 'select.all', title: 'Select all', group: 'List', keys: [{ kind: 'mod', key: 'a', modes: ['list'] }] },
  { id: 'select.extendDown', title: 'Extend selection down', group: 'List', keys: [{ kind: 'key', key: 'J', modes: ['list'] }] },
  { id: 'select.extendUp', title: 'Extend selection up', group: 'List', keys: [{ kind: 'key', key: 'K', modes: ['list'] }] },

  { id: 'thread.reply', title: 'Reply', group: 'In a thread', keys: [{ kind: 'key', key: 'r', modes: ['thread'] }] },
  { id: 'thread.replyAll', title: 'Reply all', group: 'In a thread', keys: [{ kind: 'key', key: 'R', modes: ['thread'] }] },
  { id: 'thread.forward', title: 'Forward', group: 'In a thread', keys: [{ kind: 'key', key: 'f', modes: ['thread'] }] },

  { id: 'compose.send', title: 'Send', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'Enter', modes: ['compose'] }] },
  { id: 'compose.remind', title: 'Remind me if no reply', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'h', shift: true, modes: ['compose'] }] },
  { id: 'format.bold', title: 'Bold', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'b', modes: ['compose'] }] },
  { id: 'format.italic', title: 'Italic', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'i', modes: ['compose'] }] },
  { id: 'format.underline', title: 'Underline', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'u', modes: ['compose'] }] }
]

export type Handler = (ctx: { mode: Mode }) => void | Promise<unknown>
export type Handlers = Partial<Record<CommandId, Handler>>

const NAMED: Record<string, string> = {
  Backspace: '⌫',
  Enter: '↵',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Tab: '⇥'
}

const cap = (k: string): string => NAMED[k] ?? k

export function keyCaps(spec: KeySpec): string[] {
  if (spec.kind === 'seq') return spec.keys.map(cap)
  if (spec.kind === 'mod') return ['⌘', ...(spec.shift ? ['⇧'] : []), cap(spec.key).toUpperCase()]
  const k = spec.key
  if (k === 'Shift+Tab') return ['⇧', cap('Tab')]
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

export function buildChords(mode: Mode, handlers: Handlers): Chord[] {
  return live(handlers).flatMap(({ cmd, run }) =>
    cmd.keys.flatMap((k) =>
      k.kind === 'mod' && (!k.modes || k.modes.includes(mode))
        ? [{ key: k.key, shift: k.shift, handler: () => void run({ mode }) }]
        : []
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

/**
 * `mode` is the mode under the palette (appMode's baseMode), never 'modal' for
 * the palette itself. Under anything but the list or a thread (Tasks), message
 * and list commands would act on a mail list that is not on screen, so they
 * are left out.
 */
export function buildPaletteActions(mode: Mode, handlers: Handlers): PaletteAction[] {
  const mailOnScreen = mode === 'list' || mode === 'thread'
  return live(handlers)
    .filter(({ cmd }) => cmd.palette && (mailOnScreen || (cmd.group !== 'Message' && cmd.group !== 'List')))
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
    out[id] = (ctx) =>
      timed(id, () => h(ctx)).catch((e) => console.error(`[command] ${id} failed:`, e))
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

const GROUP_ORDER: Group[] = ['General', 'Navigation', 'Message', 'List', 'In a thread', 'Compose']

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
