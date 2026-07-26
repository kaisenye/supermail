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

// Exmail's IMAP paths are verbose ("Sent Messages", "Deleted Messages") and
// SHOUTED ("INBOX"). Map the well-known ones to clean labels; everything else
// (the user's custom 客户/询价/跟进 folders) keeps its leaf name.
const FOLDER_LABELS: Record<string, string> = {
  INBOX: 'Inbox',
  'Sent Messages': 'Sent',
  Sent: 'Sent',
  Drafts: 'Drafts',
  Junk: 'Junk',
  'Deleted Messages': 'Trash',
  Trash: 'Trash'
}

/** IMAP paths are delimiter-joined; show a friendly label or the leaf. */
export function folderLabel(path: string, name: string | null): string {
  return FOLDER_LABELS[path] ?? name ?? path.split('/').pop() ?? path
}
