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
  /** The physical Control key plus a key (⌃1, ⌃Tab), on every platform. */
  | { kind: 'ctrl'; key: string; shift?: boolean; modes?: Mode[] }

export type Group = 'General' | 'Navigation' | 'Tabs' | 'Message' | 'List' | 'In a thread' | 'Compose'

export type Digit = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
export const DIGITS: Digit[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

export type CommandId =
  | 'palette.open'
  | 'search.open'
  | 'compose.new'
  | 'settings.open'
  | 'shortcuts.open'
  | 'escape'
  | 'sync.now'
  | 'account.add'
  | `account.${Digit}`
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
  | 'tab.new'
  | 'tab.close'
  | 'tab.next'
  | 'tab.prev'
  | `tab.${Digit}`
  | 'history.back'
  | 'history.forward'
  | 'page.prev'
  | 'page.next'
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
  | 'ai.ask'
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
  | 'thread.nextConv'
  | 'thread.prevConv'
  | 'thread.nextMsg'
  | 'thread.prevMsg'
  | 'thread.expand'
  | 'thread.expandAll'
  | 'thread.pageDown'
  | 'thread.pageUp'
  | 'thread.nextLink'
  | 'thread.prevLink'
  | 'thread.open'
  | 'thread.contactPane'
  | 'thread.summarize'
  | `reply.option${'1' | '2' | '3'}`
  | 'compose.send'
  | 'compose.remind'
  | 'compose.sendDone'
  | 'compose.sendLater'
  | 'compose.intro'
  | 'compose.focusTo'
  | 'compose.focusCc'
  | 'compose.focusBcc'
  | 'compose.focusSubject'
  | 'compose.snippet'
  | 'compose.ai'
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
  /**
   * How the shortcut sheet shows it: `false` hides it, an object replaces the
   * row. A numbered family (⌃1–⌃9) shows one row for all nine.
   */
  sheet?: false | { label: string; keys: string[] }
}

const LIST_THREAD: Mode[] = ['list', 'thread']
/** Where tab and history chords work: the list, a thread and the search page. */
const NAV_MODES: Mode[] = ['list', 'thread', 'search']

export const COMMANDS: Command[] = [
  {
    id: 'palette.open',
    title: 'Search and command menu',
    group: 'General',
    keys: [{ kind: 'mod', key: 'k' }]
  },
  { id: 'search.open', title: 'Search', group: 'General', palette: true, keys: [{ kind: 'key', key: '/', modes: LIST_THREAD }] },
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
    keys: [{ kind: 'key', key: 'Escape', modes: ['list', 'thread', 'search'] }]
  },
  { id: 'sync.now', title: 'Sync now', group: 'General', palette: true, keys: [] },
  { id: 'account.add', title: 'Add mailbox…', group: 'General', palette: true, keys: [] },
  ...DIGITS.map(
    (d): Command => ({
      id: `account.${d}`,
      title: `Switch to account ${d}`,
      group: 'General',
      keys: [{ kind: 'ctrl', key: d, modes: LIST_THREAD }],
      sheet: d === '1' ? { label: 'Switch to account 1–9', keys: ['⌃', '1–9'] } : false
    })
  ),

  { id: 'nav.down', title: 'Move down', group: 'Navigation', keys: [{ kind: 'key', key: 'j', modes: ['list'] }] },
  { id: 'nav.up', title: 'Move up', group: 'Navigation', keys: [{ kind: 'key', key: 'k', modes: ['list'] }] },
  { id: 'nav.open', title: 'Open message', group: 'Navigation', keys: [{ kind: 'key', key: 'Enter', modes: ['list'] }] },
  { id: 'go.inbox', title: 'Go to Inbox', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 'i'], modes: ['list'] }] },
  { id: 'go.sent', title: 'Go to Sent', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 's'], modes: ['list'] }] },
  { id: 'go.drafts', title: 'Go to Drafts', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 'd'], modes: ['list'] }] },
  { id: 'go.trash', title: 'Go to Trash', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 't'], modes: ['list'] }] },
  { id: 'go.junk', title: 'Go to Spam', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 'j'], modes: ['list'] }] },
  { id: 'go.done', title: 'Go to Done', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 'e'], modes: ['list'] }] },
  { id: 'go.reminders', title: 'Go to Reminders', group: 'Navigation', palette: true, keys: [{ kind: 'seq', keys: ['g', 'h'], modes: ['list'] }] },

  { id: 'tab.new', title: 'New tab', group: 'Tabs', palette: true, keys: [{ kind: 'mod', key: 't', modes: NAV_MODES }] },
  { id: 'tab.close', title: 'Close tab', group: 'Tabs', palette: true, keys: [{ kind: 'mod', key: 'w', modes: NAV_MODES }] },
  { id: 'tab.next', title: 'Next tab', group: 'Tabs', keys: [{ kind: 'ctrl', key: 'Tab', modes: NAV_MODES }] },
  { id: 'tab.prev', title: 'Previous tab', group: 'Tabs', keys: [{ kind: 'ctrl', key: 'Tab', shift: true, modes: NAV_MODES }] },
  ...DIGITS.map(
    (d): Command => ({
      id: `tab.${d}`,
      title: d === '9' ? 'Go to last tab' : `Go to tab ${d}`,
      group: 'Tabs',
      keys: [{ kind: 'mod', key: d, modes: NAV_MODES }],
      sheet: d === '1' ? { label: 'Go to tab 1–9', keys: ['⌘', '1–9'] } : false
    })
  ),
  { id: 'history.back', title: 'Back', group: 'Tabs', palette: true, keys: [{ kind: 'mod', key: '[', modes: NAV_MODES }] },
  { id: 'history.forward', title: 'Forward', group: 'Tabs', palette: true, keys: [{ kind: 'mod', key: ']', modes: NAV_MODES }] },

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
  // Inside ⌘K, ⇥ switches to Ask AI (palette-local); ⌘J opens the palette there directly.
  { id: 'ai.ask', title: 'Ask AI about your mail', group: 'General', keys: [{ kind: 'mod', key: 'j', modes: NAV_MODES }] },

  // R stays Reply all in a thread; a key may mean different things in different modes.
  { id: 'split.next', title: 'Next split', group: 'List', keys: [{ kind: 'key', key: 'Tab', modes: ['list'] }] },
  { id: 'split.prev', title: 'Previous split', group: 'List', keys: [{ kind: 'key', key: 'Shift+Tab', modes: ['list'] }] },
  { id: 'filter.unread', title: 'Filter: unread', group: 'List', palette: true, keys: [{ kind: 'key', key: 'U', modes: ['list'] }] },
  { id: 'filter.needsReply', title: 'Filter: needs reply', group: 'List', palette: true, keys: [{ kind: 'key', key: 'R', modes: ['list'] }] },
  { id: 'filter.waiting', title: 'Filter: waiting on others', group: 'List', palette: true, keys: [] },
  { id: 'filter.starred', title: 'Filter: starred', group: 'List', palette: true, keys: [{ kind: 'key', key: 'S', modes: ['list'] }] },
  { id: 'list.groupByDate', title: 'Group by date', group: 'List', palette: true, keys: [{ kind: 'key', key: 'D', modes: ['list'] }] },
  { id: 'select.all', title: 'Select all', group: 'List', keys: [{ kind: 'mod', key: 'a', modes: ['list'] }] },
  { id: 'page.prev', title: 'Previous page', group: 'List', palette: true, keys: [{ kind: 'mod', key: 'ArrowLeft', modes: ['list'] }] },
  { id: 'page.next', title: 'Next page', group: 'List', palette: true, keys: [{ kind: 'mod', key: 'ArrowRight', modes: ['list'] }] },
  { id: 'select.extendDown', title: 'Extend selection down', group: 'List', keys: [{ kind: 'key', key: 'J', modes: ['list'] }] },
  { id: 'select.extendUp', title: 'Extend selection up', group: 'List', keys: [{ kind: 'key', key: 'K', modes: ['list'] }] },

  { id: 'thread.reply', title: 'Reply', group: 'In a thread', keys: [{ kind: 'key', key: 'r', modes: ['thread'] }] },
  // Scape and Superhuman: ↵ replies all.
  {
    id: 'thread.replyAll',
    title: 'Reply all',
    group: 'In a thread',
    keys: [{ kind: 'key', key: 'Enter', modes: ['thread'] }, { kind: 'key', key: 'R', modes: ['thread'] }]
  },
  { id: 'thread.forward', title: 'Forward', group: 'In a thread', keys: [{ kind: 'key', key: 'f', modes: ['thread'] }] },
  // j / k are list-only otherwise, so in a thread they are free.
  { id: 'thread.nextConv', title: 'Next conversation', group: 'In a thread', keys: [{ kind: 'key', key: 'j', modes: ['thread'] }] },
  { id: 'thread.prevConv', title: 'Previous conversation', group: 'In a thread', keys: [{ kind: 'key', key: 'k', modes: ['thread'] }] },
  { id: 'thread.nextMsg', title: 'Next message', group: 'In a thread', keys: [{ kind: 'key', key: 'n', modes: ['thread'] }] },
  { id: 'thread.prevMsg', title: 'Previous message', group: 'In a thread', keys: [{ kind: 'key', key: 'p', modes: ['thread'] }] },
  { id: 'thread.expand', title: 'Expand / collapse message', group: 'In a thread', keys: [{ kind: 'key', key: 'o', modes: ['thread'] }] },
  { id: 'thread.expandAll', title: 'Expand / collapse all', group: 'In a thread', keys: [{ kind: 'key', key: 'O', modes: ['thread'] }] },
  { id: 'thread.pageDown', title: 'Page down', group: 'In a thread', keys: [{ kind: 'key', key: 'Space', modes: ['thread'] }] },
  { id: 'thread.pageUp', title: 'Page up', group: 'In a thread', keys: [{ kind: 'key', key: 'Shift+Space', modes: ['thread'] }] },
  { id: 'thread.nextLink', title: 'Next link', group: 'In a thread', keys: [{ kind: 'key', key: 'Tab', modes: ['thread'] }] },
  { id: 'thread.prevLink', title: 'Previous link', group: 'In a thread', keys: [{ kind: 'key', key: 'Shift+Tab', modes: ['thread'] }] },
  { id: 'thread.open', title: 'Open link or attachment', group: 'In a thread', keys: [{ kind: 'mod', key: 'o', modes: ['thread'] }] },
  { id: 'thread.contactPane', title: 'Show / hide contact pane', group: 'In a thread', palette: true, keys: [{ kind: 'key', key: 'i', modes: ['thread'] }] },
  { id: 'thread.summarize', title: 'Summarize conversation', group: 'In a thread', palette: true, keys: [] },
  // Instant Reply (Phase 4): bare digits are free in a thread (⌃ / ⌘ digits are accounts and tabs).
  ...(['1', '2', '3'] as const).map(
    (d): Command => ({
      id: `reply.option${d}`,
      title: `Instant reply ${d}`,
      group: 'In a thread',
      keys: [{ kind: 'key', key: d, modes: ['thread'] }],
      sheet: d === '1' ? { label: 'Instant reply 1–3', keys: ['1–3'] } : false
    })
  ),

  { id: 'compose.send', title: 'Send', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'Enter', modes: ['compose'] }] },
  { id: 'compose.sendDone', title: 'Send and mark done', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'Enter', shift: true, modes: ['compose'] }] },
  { id: 'compose.sendLater', title: 'Send later…', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'l', shift: true, modes: ['compose'] }] },
  { id: 'compose.intro', title: 'Instant intro (sender to Bcc)', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'i', shift: true, modes: ['compose'] }] },
  { id: 'compose.focusTo', title: 'Go to To', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'o', shift: true, modes: ['compose'] }] },
  { id: 'compose.focusCc', title: 'Go to Cc', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'c', shift: true, modes: ['compose'] }] },
  { id: 'compose.focusBcc', title: 'Go to Bcc', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'b', shift: true, modes: ['compose'] }] },
  { id: 'compose.focusSubject', title: 'Go to Subject', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 's', shift: true, modes: ['compose'] }] },
  { id: 'compose.snippet', title: 'Insert snippet…', group: 'Compose', external: true, keys: [{ kind: 'mod', key: ';', modes: ['compose'] }] },
  { id: 'compose.ai', title: 'Write with AI…', group: 'Compose', external: true, keys: [{ kind: 'mod', key: 'j', modes: ['compose'] }] },
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
  ArrowLeft: '←',
  ArrowRight: '→',
  Tab: '⇥',
  Space: 'Space'
}

const cap = (k: string): string => NAMED[k] ?? k

export function keyCaps(spec: KeySpec): string[] {
  if (spec.kind === 'seq') return spec.keys.map(cap)
  if (spec.kind === 'ctrl') return ['⌃', ...(spec.shift ? ['⇧'] : []), cap(spec.key).toUpperCase()]
  if (spec.kind === 'mod') return ['⌘', ...(spec.shift ? ['⇧'] : []), cap(spec.key).toUpperCase()]
  const k = spec.key
  if (k === 'Shift+Tab') return ['⇧', cap('Tab')]
  if (k === 'Shift+Space') return ['⇧', 'Space']
  // A shifted letter arrives as its capital (R); show the Shift it took.
  if (k.length === 1 && k !== k.toLowerCase()) return ['⇧', k]
  return [cap(k)]
}

function hint(spec: KeySpec): string {
  return keyCaps(spec).join(spec.kind === 'seq' ? ' ' : '')
}

/** Commands this component actually handles. */
function live(handlers: Handlers, commands: Command[] = COMMANDS): { cmd: Command; run: Handler }[] {
  return commands.flatMap((cmd) => {
    const run = handlers[cmd.id]
    return run && !cmd.external ? [{ cmd, run }] : []
  })
}

export function buildBindings(mode: Mode, handlers: Handlers, commands: Command[] = COMMANDS): Binding[] {
  return live(handlers, commands).flatMap(({ cmd, run }) =>
    cmd.keys.flatMap((k) =>
      k.kind === 'key'
        ? [{ key: k.key, modes: k.modes, handler: () => void run({ mode }) }]
        : []
    )
  )
}

export function buildChords(mode: Mode, handlers: Handlers, commands: Command[] = COMMANDS): Chord[] {
  return live(handlers, commands).flatMap(({ cmd, run }) =>
    cmd.keys.flatMap((k) =>
      (k.kind === 'mod' || k.kind === 'ctrl') && (!k.modes || k.modes.includes(mode))
        ? [{ key: k.key, shift: k.shift, ctrl: k.kind === 'ctrl' || undefined, handler: () => void run({ mode }) }]
        : []
    )
  )
}

/** First key -> second key -> action, for the sequences allowed in `mode`. */
export function buildSequences(
  mode: Mode,
  handlers: Handlers,
  commands: Command[] = COMMANDS
): Record<string, Record<string, () => void>> {
  const out: Record<string, Record<string, () => void>> = {}
  for (const { cmd, run } of live(handlers, commands)) {
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
export function buildPaletteActions(
  mode: Mode,
  handlers: Handlers,
  commands: Command[] = COMMANDS
): PaletteAction[] {
  const mailOnScreen = mode === 'list' || mode === 'thread'
  return live(handlers, commands)
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

const GROUP_ORDER: Group[] = ['General', 'Navigation', 'Tabs', 'Message', 'List', 'In a thread', 'Compose']

export function shortcutGroups(commands: Command[] = COMMANDS): { title: Group; items: SheetRow[] }[] {
  return GROUP_ORDER.map((title) => ({
    title,
    items: commands
      .filter((c) => c.group === title && c.keys.length > 0 && c.sheet !== false)
      .map((c) =>
        c.sheet
          ? { label: c.sheet.label, keys: c.sheet.keys }
          : {
              label: c.title,
              keys: keyCaps(c.keys[0]),
              then: c.keys[0].kind === 'seq' || undefined,
              alt: c.keys[1] ? keyCaps(c.keys[1]) : undefined
            }
      )
  })).filter((g) => g.items.length > 0)
}
