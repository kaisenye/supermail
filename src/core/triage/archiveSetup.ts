import type { MailProvider } from '../accounts/auth.js'
import { doneRole } from '../store/folderRoles.js'

export const GMAIL_ALL_MAIL_HIDDEN =
  "Gmail's All Mail is hidden from IMAP. Turn on Show in IMAP for All Mail in Gmail settings, then sync again."

/**
 * Whether Settings may offer to create a Done folder. Only an 'archive' role
 * can be satisfied by creating "Archive": Gmail's Done target is All Mail, so
 * a new "Archive" label there would never be used and would only litter the
 * user's server.
 */
export function archiveSetup(
  provider: MailProvider,
  hasDoneFolder: boolean
): { hasArchive: boolean; canCreate: boolean; reason?: string } {
  if (hasDoneFolder) return { hasArchive: true, canCreate: false }
  if (doneRole(provider) !== 'archive') {
    return { hasArchive: false, canCreate: false, reason: GMAIL_ALL_MAIL_HIDDEN }
  }
  return { hasArchive: false, canCreate: true }
}
