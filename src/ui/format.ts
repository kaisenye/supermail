import type { Folder } from '../core/store/types'
import type { FolderRole } from '../core/store/folderRoles'

const DAY = 86_400_000

/** Superhuman-style relative dates: fixed width, no "ago" noise. */
export function formatDate(epoch: number | null): string {
  if (!epoch) return ''
  const d = new Date(epoch)
  const now = new Date()
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear()

  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }
  const delta = now.getTime() - epoch
  if (delta < 7 * DAY) return d.toLocaleDateString(undefined, { weekday: 'short' })
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
}

/** Prefer a display name; fall back to the local part of the address. */
export function senderLabel(name: string | null, addr: string | null): string {
  if (name?.trim()) return name.trim()
  if (!addr) return '(unknown)'
  return addr.split('@')[0] || addr
}

/**
 * Who a message went to, for folders where the sender is always you.
 * Extra recipients collapse to "+N" so the column stays one line.
 */
export function recipientLabel(
  toAddrs: string | null | undefined,
  fallback: string
): string {
  // undefined means the column was never selected — an older main process, not
  // a message without recipients. Fall back to the sender rather than claim
  // there is no recipient.
  if (toAddrs === undefined) return fallback
  if (!toAddrs) return '(no recipient)'
  let list: { address?: string | null; name?: string | null }[]
  try {
    list = JSON.parse(toAddrs)
  } catch {
    return fallback
  }
  if (!Array.isArray(list) || !list.length) return '(no recipient)'
  const first = senderLabel(list[0]?.name ?? null, list[0]?.address ?? null)
  return list.length > 1 ? `${first} +${list.length - 1}` : first
}

/**
 * Snippets built from a message's plain-text part never passed through the
 * HTML stripper, so entities like &nbsp; survive as literal text. Decode at
 * render time — that also repairs rows already in the database.
 */
export function decodeEntities(s: string | null): string {
  if (!s) return ''
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseFlags(flags: string | null): string[] {
  if (!flags) return []
  try {
    const v = JSON.parse(flags)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export const isUnread = (flags: string | null): boolean =>
  !parseFlags(flags).some((f) => f.toLowerCase() === '\\seen' || f.toLowerCase() === 'seen')

export const isFlagged = (flags: string | null): boolean =>
  parseFlags(flags).some((f) => f.toLowerCase() === '\\flagged' || f.toLowerCase() === 'flagged')

const ROLE_LABELS: Record<FolderRole, string> = {
  inbox: 'Inbox',
  sent: 'Sent',
  drafts: 'Drafts',
  trash: 'Trash',
  junk: 'Junk',
  archive: 'Archive',
  all: 'All Mail'
}

/**
 * Special folders get a clean label whatever the server calls them
 * ("Sent Messages", "[Gmail]/Sent Mail"); custom folders (客户/询价/跟进) keep
 * their own name, or the leaf of the path.
 */
export function folderLabel(f: Pick<Folder, 'path' | 'name' | 'role'>): string {
  if (f.role) return ROLE_LABELS[f.role]
  return f.name ?? f.path.split('/').pop() ?? f.path
}
