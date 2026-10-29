import type { MailProvider } from '../accounts/auth.js'
import type { Folder } from '../store/types.js'

/**
 * Gmail exposes every label, plus All Mail, as an IMAP folder holding another
 * copy of the same messages. Syncing them would multiply storage, unread
 * counts, search hits and thread sizes, so a Gmail account syncs only its
 * system folders. Labels arrive later via X-GM-LABELS (Phase 2).
 */
const GMAIL_ROLES = new Set(['inbox', 'sent', 'drafts', 'trash', 'junk'])

export function shouldSyncFolder(
  provider: MailProvider,
  folder: Pick<Folder, 'path' | 'role'>
): boolean {
  if (provider !== 'gmail') return true
  return folder.role !== null && GMAIL_ROLES.has(folder.role)
}
