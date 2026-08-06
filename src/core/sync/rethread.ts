import type { ImapFlow } from 'imapflow'
import { getDb } from '../store/db.js'
import { ensureMessageIdFormat, parseReferences } from './imap.js'

/**
 * Repairs threading for mail synced before References was fetched.
 *
 * IMAP's ENVELOPE has no References field (RFC 3501), so envelope-first sync
 * could only thread on a message's own id — every reply became its own thread.
 * This pulls the two header lines (never the bodies) and recomputes the root.
 */

/** `<>` and blanks are not ids; Zimbra emits an empty leading reference. */
function validId(id: string | null | undefined): string | null {
  const t = id?.trim()
  if (!t || t === '<>' || t === '<' || t === '>') return null
  return t
}

/**
 * Union-find over message ids.
 *
 * Taking references[0] as the root only works when every reply carries the full
 * chain. Exmail's own replies drop References entirely and Zimbra truncates it,
 * so the same conversation arrives with several different "roots". Linking a
 * message to every id it mentions merges those into one set regardless.
 */
class Union {
  private parent = new Map<string, string>()

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x)
      return x
    }
    // Walk to the root, then point every node on the path straight at it.
    const seen: string[] = []
    let cur = x
    for (;;) {
      const p = this.parent.get(cur) ?? cur
      if (p === cur) break
      seen.push(cur)
      cur = p
    }
    for (const n of seen) this.parent.set(n, cur)
    return cur
  }

  link(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(rb, ra)
  }
}

export interface RethreadResult {
  scanned: number
  updated: number
}

/**
 * Every message in the folder, not just the broken ones: union-find can only
 * merge two fragments if it sees both. Excluding already-threaded mail would
 * leave the halves of a split conversation unable to find each other.
 */
function folderMessages(accountId: number, folderId: number): { id: number; uid: number }[] {
  return getDb()
    .prepare(
      `SELECT id, uid FROM messages
        WHERE account_id = ? AND folder_id = ? AND uid IS NOT NULL
        ORDER BY uid`
    )
    .all(accountId, folderId) as { id: number; uid: number }[]
}

const BATCH = 500

interface Parsed {
  id: number
  own: string | null
  irt: string | null
  ids: string[]
}

/** Reads one folder's threading headers into the shared union. */
async function scanFolder(
  client: ImapFlow,
  accountId: number,
  folderId: number,
  path: string,
  union: Union,
  out: Parsed[]
): Promise<number> {
  const targets = folderMessages(accountId, folderId)
  if (!targets.length) return 0
  const byUid = new Map(targets.map((t) => [t.uid, t.id]))

  const lock = await client.getMailboxLock(path)
  try {
    const uids = [...byUid.keys()]
    for (let i = 0; i < uids.length; i += BATCH) {
      for await (const msg of client.fetch(
        uids.slice(i, i + BATCH).join(','),
        { uid: true, envelope: true, headers: ['references', 'in-reply-to'] },
        { uid: true }
      )) {
        const id = byUid.get(msg.uid)
        if (!id) continue
        const own = msg.envelope?.messageId
          ? validId(ensureMessageIdFormat(msg.envelope.messageId))
          : null
        // ENVELOPE's inReplyTo is unset on Exmail, so prefer the raw header.
        const hdr = msg.headers?.toString() ?? ''
        const rawIrt = /^in-reply-to:\s*(.*)$/im.exec(hdr)?.[1]?.trim() ?? null
        const irt = validId(
          rawIrt ? ensureMessageIdFormat(rawIrt) : (msg.envelope?.inReplyTo ?? null)
        )
        const refs = (parseReferences(msg.headers) ?? [])
          .map(validId)
          .filter((r): r is string => r !== null)

        const ids = [...new Set([...(own ? [own] : []), ...(irt ? [irt] : []), ...refs])]
        // Every id this message mentions belongs to one conversation.
        for (const other of ids) if (other !== ids[0]) union.link(ids[0], other)
        out.push({ id, own, irt, ids })
      }
    }
  } finally {
    lock.release()
  }
  return targets.length
}

/**
 * Rethreads a whole account in one pass.
 *
 * Account-wide rather than per-folder on purpose: a reply you sent lives in
 * Sent while the message it answers is in INBOX, and Exmail strips References
 * from its own outgoing mail. Only a union spanning both folders can put the
 * two halves of that conversation back together.
 */
export async function rethreadAccount(
  client: ImapFlow,
  accountId: number,
  folders: { id: number; path: string }[]
): Promise<RethreadResult> {
  const union = new Union()
  const parsed: Parsed[] = []
  let scanned = 0

  for (const f of folders) {
    scanned += await scanFolder(client, accountId, f.id, f.path, union, parsed)
  }
  if (!parsed.length) return { scanned, updated: 0 }

  // Assign only after every folder is linked: a set's representative is not
  // stable until the last message that could merge two sets has been seen.
  const rows = parsed
    .map((p) => ({
      id: p.id,
      irt: p.irt,
      // Bulk senders often omit Message-ID entirely. Falling back to a
      // per-row key keeps those as threads of one rather than collapsing
      // every id-less message in the mailbox into a single bucket.
      thread: p.ids.length ? union.find(p.ids[0]) : (p.own ?? `local:${p.id}`)
    }))
    .filter((r) => r.thread)

  const update = getDb().prepare(
    'UPDATE messages SET thread_id = ?, in_reply_to = ? WHERE id = ?'
  )
  const run = getDb().transaction(() => {
    for (const r of rows) update.run(r.thread, r.irt, r.id)
  })
  run()

  return { scanned, updated: rows.length }
}
