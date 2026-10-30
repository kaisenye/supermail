import type { MailProvider } from '../accounts/auth.js'
import { doneRole, type MoveTarget } from '../store/folderRoles.js'
import {
  folderByRole,
  getFolder,
  getMessageLocation,
  groupByAccount,
  threadMatesInFolder
} from '../store/repo.js'
import type { Folder } from '../store/types.js'

/** One message's optimistic move, with everything undo and the IMAP MOVE need. */
export interface PlannedMove {
  id: number
  accountId: number
  fromFolderId: number
  fromPath: string
  uid: number
  toFolderId: number
  toPath: string
  uidValidity: number | null
}

export function resolveTarget(
  accountId: number,
  provider: MailProvider,
  target: MoveTarget
): Folder | undefined {
  if ('folderId' in target) {
    const f = getFolder(target.folderId)
    return f?.account_id === accountId ? f : undefined
  }
  // Done is sent as { role: 'archive' } by every account; Gmail's is All Mail.
  return folderByRole(accountId, target.role === 'archive' ? doneRole(provider) : target.role)
}

/**
 * Expands row ids to their thread in that folder and resolves each account's
 * destination. Resolves every destination before returning, so a missing
 * folder on one account cannot leave a half-applied move.
 */
export function planMoves(
  ids: number[],
  target: MoveTarget,
  providerOf: (accountId: number) => MailProvider | null
): { ok: true; plan: PlannedMove[] } | { ok: false; error: string } {
  const plan: PlannedMove[] = []
  const seen = new Set<number>()
  for (const [accountId, own] of groupByAccount(ids)) {
    const provider = providerOf(accountId)
    if (!provider) continue
    const dest = resolveTarget(accountId, provider, target)
    if (!dest) {
      return { ok: false, error: 'role' in target ? `no ${target.role} folder` : 'unknown folder' }
    }
    for (const rowId of own) {
      for (const id of threadMatesInFolder(rowId)) {
        if (seen.has(id)) continue
        seen.add(id)
        const loc = getMessageLocation(id)
        // No uid: already mid-move (an earlier optimistic move nulled it).
        if (!loc?.uid || loc.folder_id === dest.id) continue
        plan.push({
          id,
          accountId,
          fromFolderId: loc.folder_id,
          fromPath: loc.path,
          uid: loc.uid,
          toFolderId: dest.id,
          toPath: dest.path,
          uidValidity: getFolder(loc.folder_id)?.uidvalidity ?? null
        })
      }
    }
  }
  return { ok: true, plan }
}
