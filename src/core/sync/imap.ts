import { ImapFlow, type ListResponse } from 'imapflow'
import type { AccountConfig } from '../accounts/config.js'
import type { RawMessage } from '../pipeline/types.js'

export interface MailboxInfo {
  path: string
  name: string
  specialUse: string | null
  selectable: boolean
}

export function createClient(config: AccountConfig): ImapFlow {
  return new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: true,
    auth: { user: config.email, pass: config.pass },
    logger: false,
    // Exmail can be slow to greet; default 90s is fine but be explicit.
    greetingTimeout: 30_000,
    socketTimeout: 120_000
  })
}

/** \NoSelect entries are containers (e.g. 其他文件夹) — selecting them errors. */
export function toMailboxInfo(b: ListResponse): MailboxInfo {
  const flags = b.flags instanceof Set ? [...b.flags] : (b.flags ?? [])
  return {
    path: b.path,
    name: b.name,
    specialUse: b.specialUse ?? null,
    selectable: !flags.includes('\\NoSelect')
  }
}

export async function listMailboxes(client: ImapFlow): Promise<MailboxInfo[]> {
  const boxes = await client.list()
  return boxes.map(toMailboxInfo)
}

export interface MailboxStatus {
  uidValidity: number
  uidNext: number
  exists: number
  /** Cheap signal that a read/unread happened elsewhere; UIDNEXT cannot show it. */
  unseen: number
}

/**
 * STATUS is far cheaper than SELECT — it avoids the per-mailbox select
 * round-trip that dominates sync time on folders with nothing new.
 */
export async function mailboxStatus(
  client: ImapFlow,
  path: string
): Promise<MailboxStatus> {
  const s = await client.status(path, {
    uidValidity: true,
    uidNext: true,
    messages: true,
    unseen: true
  })
  return {
    uidValidity: Number(s.uidValidity),
    uidNext: Number(s.uidNext),
    exists: s.messages ?? 0,
    unseen: s.unseen ?? 0
  }
}

/**
 * Normalises a message-id to `<...>`. mailparser does this on the body pass,
 * so the envelope pass must too or the same message threads two ways.
 */
function ensureMessageIdFormat(value: string): string | null {
  const v = value.trim()
  if (!v) return null
  return `${v.startsWith('<') ? '' : '<'}${v}${v.endsWith('>') ? '' : '>'}`
}

/**
 * RFC 5322 References is whitespace/CRLF separated <msgid> tokens. Split the
 * same way mailparser does so both sync passes yield an identical array.
 */
function parseReferences(headers: Buffer | undefined): string[] | null {
  if (!headers) return null
  // Unfold continuation lines (CRLF + WSP) before matching the field body.
  const m = /^references:\s*([\s\S]*?)$/im.exec(
    headers.toString('utf8').replace(/\r?\n[ \t]+/g, ' ')
  )
  if (!m) return null
  const refs = m[1]
    .split(/\s+/)
    .map(ensureMessageIdFormat)
    .filter((r): r is string => r !== null)
  return refs.length ? refs : null
}

/**
 * Fetches envelopes for uid > sinceUid, newest-first, capped at `limit`.
 * Bodies are deliberately excluded so the list can render before they arrive.
 */
export async function fetchEnvelopes(
  client: ImapFlow,
  path: string,
  opts: { sinceUid: number; limit: number; accountId: number; folderId: number }
): Promise<{ status: MailboxStatus; messages: RawMessage[] }> {
  const lock = await client.getMailboxLock(path)
  try {
    const mb = client.mailbox
    if (!mb || typeof mb === 'boolean') throw new Error(`cannot select ${path}`)

    const status: MailboxStatus = {
      uidValidity: Number(mb.uidValidity),
      uidNext: Number(mb.uidNext),
      exists: mb.exists,
      // SELECT reports unseen as a first-index, not a count; callers that need
      // the count use mailboxStatus(), so leave it at 0 here rather than lie.
      unseen: 0
    }

    const messages: RawMessage[] = []
    if (mb.exists === 0 || status.uidNext <= opts.sinceUid + 1) {
      return { status, messages }
    }

    const range = `${opts.sinceUid + 1}:*`
    for await (const msg of client.fetch(
      range,
      // ENVELOPE carries message-id/in-reply-to but not references (RFC 3501),
      // so pull that one header line too — threading needs it on this pass.
      { uid: true, envelope: true, flags: true, headers: ['references'] },
      { uid: true }
    )) {
      // `n:*` always returns at least one message even when none match.
      if (msg.uid <= opts.sinceUid) continue
      messages.push({
        accountId: opts.accountId,
        folderId: opts.folderId,
        uid: msg.uid,
        envelope: {
          messageId: msg.envelope?.messageId
            ? ensureMessageIdFormat(msg.envelope.messageId)
            : null,
          inReplyTo: msg.envelope?.inReplyTo
            ? ensureMessageIdFormat(msg.envelope.inReplyTo)
            : null,
          references: parseReferences(msg.headers),
          from: msg.envelope?.from?.[0]
            ? { address: msg.envelope.from[0].address, name: msg.envelope.from[0].name }
            : null,
          to: msg.envelope?.to?.map((a) => ({ address: a.address, name: a.name })) ?? [],
          cc: msg.envelope?.cc?.map((a) => ({ address: a.address, name: a.name })) ?? [],
          subject: msg.envelope?.subject ?? null,
          date: msg.envelope?.date ?? null
        },
        flags: msg.flags ? [...msg.flags] : []
      })
    }

    // Newest first, so the most recent N survive the cap.
    messages.sort((a, b) => (b.uid ?? 0) - (a.uid ?? 0))
    return { status, messages: messages.slice(0, opts.limit) }
  } finally {
    lock.release()
  }
}

/**
 * UID -> flags for a whole mailbox. No envelopes or bodies, so this stays a
 * few KB even on large folders — it's the only way to see a read/unread or
 * star made in another client, since those never move UIDNEXT.
 */
export async function fetchFlags(
  client: ImapFlow,
  path: string
): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>()
  const lock = await client.getMailboxLock(path)
  try {
    const mb = client.mailbox
    if (!mb || typeof mb === 'boolean' || mb.exists === 0) return out
    for await (const msg of client.fetch('1:*', { uid: true, flags: true }, { uid: true })) {
      out.set(msg.uid, msg.flags ? [...msg.flags] : [])
    }
  } finally {
    lock.release()
  }
  return out
}

/** Add or remove one IMAP flag on a message by UID. */
export async function storeFlag(
  client: ImapFlow,
  path: string,
  uid: number,
  flag: string,
  add: boolean
): Promise<void> {
  const lock = await client.getMailboxLock(path)
  try {
    if (add) {
      await client.messageFlagsAdd(String(uid), [flag], { uid: true })
    } else {
      await client.messageFlagsRemove(String(uid), [flag], { uid: true })
    }
  } finally {
    lock.release()
  }
}

/** MOVE one UID from source mailbox to destination path. */
export async function moveUid(
  client: ImapFlow,
  fromPath: string,
  uid: number,
  toPath: string
): Promise<void> {
  const lock = await client.getMailboxLock(fromPath)
  try {
    await client.messageMove(String(uid), toPath, { uid: true })
  } finally {
    lock.release()
  }
}

/**
 * Streams RFC822 source for many UIDs over a single mailbox lock. The caller
 * pipelines each as it arrives, so a large folder never buffers in memory.
 */
export async function fetchSourcesBatch(
  client: ImapFlow,
  path: string,
  uids: number[],
  onOne: (uid: number, source: Buffer) => Promise<void>
): Promise<void> {
  if (!uids.length) return
  const lock = await client.getMailboxLock(path)
  try {
    for await (const msg of client.fetch(
      uids,
      { uid: true, source: true },
      { uid: true }
    )) {
      if (msg.source) await onOne(msg.uid, msg.source)
    }
  } finally {
    lock.release()
  }
}

/** Full RFC822 source for one message — used by the lazy body fetch. */
export async function fetchSource(
  client: ImapFlow,
  path: string,
  uid: number
): Promise<Buffer | null> {
  const lock = await client.getMailboxLock(path)
  try {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true })
    if (!msg || typeof msg === 'boolean' || !msg.source) return null
    return msg.source
  } finally {
    lock.release()
  }
}
