/** What a folder is for, independent of what the server calls it. */
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all'

/** Where a move goes: a role (resolved per account) or one specific folder. */
export type MoveTarget = { role: FolderRole } | { folderId: number }

export interface RoleCandidate {
  path: string
  /** RFC 6154 attribute as imapflow reports it, e.g. '\\Sent'. */
  specialUse: string | null
}

const SPECIAL_USE: Record<string, FolderRole> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all'
}

/**
 * Lower-cased names for servers without SPECIAL-USE (Exmail). Earlier entries
 * win, which keeps the order of the old hardcoded SENT_PATHS / TRASH_PATHS.
 */
const NAMES: Record<FolderRole, string[]> = {
  inbox: ['inbox'],
  sent: ['sent messages', 'sent', 'sent items', 'sent mail'],
  drafts: ['drafts', 'draft'],
  trash: ['deleted messages', 'trash', 'deleted items', 'deleted', 'bin'],
  junk: ['junk', 'spam', 'junk email', 'junk e-mail', 'bulk mail'],
  archive: ['archive', 'archives'],
  all: ['all mail']
}

/**
 * Leaf name, lower-cased, for top-level folders and children of INBOX only.
 * A nested user folder such as Projects/Archive must never become the
 * account's archive just because of its name.
 */
function topLevelLeaf(path: string): string | null {
  const parts = path.split(/[/.]/)
  if (parts.length === 1) return parts[0].toLowerCase()
  if (parts.length === 2 && parts[0].toUpperCase() === 'INBOX') return parts[1].toLowerCase()
  return null
}

/**
 * One folder per role for an account. INBOX is fixed by RFC 3501; then
 * SPECIAL-USE; then names. Returns path -> role for the folders that got one.
 */
export function assignRoles(boxes: RoleCandidate[]): Map<string, FolderRole> {
  const out = new Map<string, FolderRole>()
  const taken = new Set<FolderRole>()
  const give = (path: string, role: FolderRole): void => {
    out.set(path, role)
    taken.add(role)
  }

  const inbox = boxes.find((b) => b.path.toUpperCase() === 'INBOX')
  if (inbox) give(inbox.path, 'inbox')

  for (const b of boxes) {
    const role = b.specialUse ? SPECIAL_USE[b.specialUse] : undefined
    if (!role || taken.has(role) || out.has(b.path)) continue
    give(b.path, role)
  }

  for (const role of Object.keys(NAMES) as FolderRole[]) {
    if (taken.has(role)) continue
    let best: { path: string; rank: number } | null = null
    for (const b of boxes) {
      if (out.has(b.path)) continue
      const leaf = topLevelLeaf(b.path)
      if (leaf === null) continue
      const rank = NAMES[role].indexOf(leaf)
      if (rank !== -1 && (!best || rank < best.rank)) best = { path: b.path, rank }
    }
    if (best) give(best.path, role)
  }

  return out
}
