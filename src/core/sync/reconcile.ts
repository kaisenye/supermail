import type { ImapFlow } from 'imapflow'
import { deleteMessageLocal, listFlagState, setFlags } from '../store/repo.js'
import { fetchFlags } from './imap.js'

export interface ReconcileResult {
  /** Messages whose flags differed from the server and were corrected. */
  updated: number
  /** Rows dropped because the uid is gone from the mailbox. */
  vanished: number
}

/**
 * Pulls read/unread, star and deletion state made in ANOTHER client.
 *
 * Incremental sync only fetches uid > last_uid, and a flag change never moves
 * UIDNEXT — so without this pass those changes are invisible forever. Exmail
 * advertises neither CONDSTORE nor QRESYNC, so a full flags-only FETCH is the
 * cheapest correct option; it carries no envelopes or bodies.
 */
export async function reconcileFolder(
  client: ImapFlow,
  path: string,
  folderId: number,
  opts: { skipIds?: Set<number>; dropVanished?: boolean } = {}
): Promise<ReconcileResult> {
  const skip = opts.skipIds ?? new Set<number>()
  const local = listFlagState(folderId)
  if (!local.length) return { updated: 0, vanished: 0 }

  const remote = await fetchFlags(client, path)
  // An empty result means the folder is empty or the FETCH failed; treating
  // that as "everything vanished" would delete the whole folder locally.
  if (remote.size === 0) return { updated: 0, vanished: 0 }

  let updated = 0
  let vanished = 0

  for (const row of local) {
    // A pending local write is newer than what the server can tell us.
    if (skip.has(row.id)) continue

    const serverFlags = remote.get(row.uid)
    if (!serverFlags) {
      if (opts.dropVanished) {
        deleteMessageLocal(row.id)
        vanished++
      }
      continue
    }

    if (sameFlags(row.flags, serverFlags)) continue
    setFlags(row.id, JSON.stringify(serverFlags))
    updated++
  }

  return { updated, vanished }
}

/** Order and case are not significant in an IMAP flag list. */
function sameFlags(stored: string | null, server: string[]): boolean {
  let current: string[]
  try {
    current = stored ? (JSON.parse(stored) as string[]) : []
  } catch {
    return false
  }
  if (current.length !== server.length) return false
  const a = current.map((f) => f.toLowerCase()).sort()
  const b = server.map((f) => f.toLowerCase()).sort()
  return a.every((f, i) => f === b[i])
}
