import type { Folder } from '../core/store/types'
import type { MailProvider } from '../core/accounts/auth'
import { doneRole } from '../core/store/folderRoles'
import { useStore } from './store'

interface FolderApi {
  listFolders(): Promise<Folder[]>
}

interface ArchiveApi extends FolderApi {
  createArchive(): Promise<{ ok: true } | { ok: false; error: string }>
}

/**
 * Re-read the folder list from SQLite into the store. The sidebar and `g`
 * jumps (gotoFolder looks folders up by role) both read the store, so a folder
 * added after boot is invisible until this runs.
 */
export async function reloadFolders(api: FolderApi = window.api): Promise<void> {
  useStore.getState().setFolders(await api.listFolders())
}

/** Create the Archive folder on the server, then show it without a restart. */
export async function createArchiveFolder(
  api: ArchiveApi = window.api
): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await api.createArchive()
  if (r.ok) await reloadFolders(api)
  return r
}

/**
 * Where `g e` (Go to Done) goes. Done moves mail to the provider's done role,
 * which on Gmail is All Mail; All Mail is not synced or listed, so there is no
 * Done view there and the user is told why instead of nothing happening.
 */
export function goDoneTarget(
  folders: Folder[],
  provider: MailProvider | null | undefined
): { folderId: number } | { message: string } {
  const role = doneRole(provider ?? 'imap')
  const f = folders.find((x) => x.role === role)
  if (f) return { folderId: f.id }
  return {
    message:
      provider === 'gmail'
        ? 'On Gmail, Done mail lives in All Mail, which Supermail does not show as a folder.'
        : 'No Done folder yet. Create one in Settings → Done folder.'
  }
}
