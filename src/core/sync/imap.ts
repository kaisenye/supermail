import { ImapFlow, type FetchMessageObject, type FetchQueryObject, type ListResponse } from 'imapflow'
import type { AccountConfig } from '../accounts/config.js'
import type { RawMessage } from '../pipeline/types.js'
import { resolveAuth } from '../accounts/auth.js'
import { listHeadersFrom } from '../pipeline/listHeaders.js'

export interface MailboxInfo {
  path: string
  name: string
  specialUse: string | null
  selectable: boolean
}

export async function createClient(config: AccountConfig): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    // 993 is implicit TLS; 143 upgrades with STARTTLS. Hardcoding true broke
    // any server on 143.
    secure: config.imapPort === 993,
    // Off 993, require the upgrade: imapflow's default carries on in cleartext
    // when STARTTLS is not offered, which would expose the password or token.
    doSTARTTLS: config.imapPort === 993 ? undefined : true,
    auth: await resolveAuth(config),
    logger: false,
    // Exmail can be slow to greet; default 90s is fine but be explicit.
    greetingTimeout: 30_000,
    socketTimeout: 120_000
  })
  // ImapFlow is an EventEmitter, so an unhandled 'error' — a socket timeout on
  // a long sync, most often — would take down the whole main process. The
  // awaited call rejects on its own; this only stops the crash. Callers that
  // need to react (pool eviction, IDLE reconnect) add their own listener.
  client.on('error', () => {})
  return client
}

/** \NoSelect entries are containers (e.g. 其他文件夹) — selecting them errors. */
export function toMailboxInfo(b: ListResponse): MailboxInfo {
  const flags = b.flags instanceof Set ? [...b.flags] : (b.flags ?? [])
  return {
    path: b.path,
    name: b.name,
    // imapflow fills specialUse from name guesses at any depth when the server
    // advertises none (specialUseSource 'name', untyped). assignRoles applies
    // its own stricter, top-level-only name rules, so keep only real flags.
    specialUse:
      (b as { specialUseSource?: string }).specialUseSource === 'name'
        ? null
        : (b.specialUse ?? null),
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
export function ensureMessageIdFormat(value: string): string | null {
  const v = value.trim()
  if (!v) return null
  return `${v.startsWith('<') ? '' : '<'}${v}${v.endsWith('>') ? '' : '>'}`
}

/**
 * RFC 5322 References is whitespace/CRLF separated <msgid> tokens. Split the
 * same way mailparser does so both sync passes yield an identical array.
 */
export function parseReferences(headers: Buffer | undefined): string[] | null {
  if (!headers) return null
  // Unfold continuation lines (CRLF + WSP) before matching the field body.
  // Stay on one line: other fetched header fields follow References.
  const m = /^references:[ \t]*(.*)$/im.exec(
    headers.toString('utf8').replace(/\r?\n[ \t]+/g, ' ')
  )
  if (!m) return null
  const refs = m[1]
    .split(/\s+/)
    .map(ensureMessageIdFormat)
    .filter((r): r is string => r !== null)
  return refs.length ? refs : null
}

/** Header lines pulled with every envelope: threading plus list detection. */
export const ENVELOPE_HEADERS = [
  'references',
  'list-unsubscribe',
  'list-unsubscribe-post',
  'list-id',
  'precedence',
  'auto-submitted'
]

/** imapflow only sends X-GM-LABELS when the server has X-GM-EXT-1, so this is safe everywhere. */
export const ENVELOPE_QUERY: FetchQueryObject = {
  uid: true,
  envelope: true,
  flags: true,
  internalDate: true,
  labels: true,
  headers: [...ENVELOPE_HEADERS]
}

/** One fetched envelope as pipeline input. Shared by sync and backfill so they cannot drift. */
export function envelopeToRaw(msg: FetchMessageObject, accountId: number, folderId: number): RawMessage {
  return {
    accountId,
    folderId,
    uid: msg.uid,
    envelope: {
      messageId: msg.envelope?.messageId ? ensureMessageIdFormat(msg.envelope.messageId) : null,
      inReplyTo: msg.envelope?.inReplyTo ? ensureMessageIdFormat(msg.envelope.inReplyTo) : null,
      references: parseReferences(msg.headers),
      from: msg.envelope?.from?.[0]
        ? { address: msg.envelope.from[0].address, name: msg.envelope.from[0].name }
        : null,
      to: msg.envelope?.to?.map((a) => ({ address: a.address, name: a.name })) ?? [],
      cc: msg.envelope?.cc?.map((a) => ({ address: a.address, name: a.name })) ?? [],
      subject: msg.envelope?.subject ?? null,
      date: msg.envelope?.date ?? null
    },
    flags: msg.flags ? [...msg.flags] : [],
    internalDate: msg.internalDate ? new Date(msg.internalDate) : null,
    listHeaders: msg.headers ? listHeadersFrom(msg.headers.toString('utf8')) : undefined,
    labels: msg.labels ? [...msg.labels] : undefined
  }
}

/**
 * Fetches envelopes for uid > sinceUid, newest-first, capped at `limit`.
 * Bodies are deliberately excluded so the list can render before they arrive.
 */
export async function fetchEnvelopes(
  client: ImapFlow,
  path: string,
  opts: {
    sinceUid: number
    limit: number
    accountId: number
    folderId: number
    /** Called with the running count as envelopes stream in. */
    onFetched?: (count: number) => void
  }
): Promise<{ status: MailboxStatus; messages: RawMessage[] }> {
  // imapflow skips SELECT when `path` is already open (a pooled connection
  // that refreshed this folder before) and never updates uidNext after that,
  // so the cached value is stale. A fresh SELECT replaces the mailbox object.
  const before = client.mailbox
  const lock = await client.getMailboxLock(path)
  try {
    const reused = !!before && client.mailbox === before
    // NOOP pulls the EXISTS/EXPUNGE updates the server held back.
    if (reused) await client.noop()
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
    // Only a fresh SELECT's UIDNEXT can rule out new mail; otherwise UID FETCH.
    if (mb.exists === 0 || (!reused && status.uidNext <= opts.sinceUid + 1)) {
      return { status, messages }
    }

    const range = `${opts.sinceUid + 1}:*`
    for await (const msg of client.fetch(range, ENVELOPE_QUERY, { uid: true })) {
      // `n:*` always returns at least one message even when none match.
      if (msg.uid <= opts.sinceUid) continue
      messages.push(envelopeToRaw(msg, opts.accountId, opts.folderId))
      opts.onFetched?.(messages.length)
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

/** UID -> Gmail labels for a mailbox. Empty on servers without X-GM-EXT-1. */
export async function fetchLabels(client: ImapFlow, path: string): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>()
  const lock = await client.getMailboxLock(path)
  try {
    const mb = client.mailbox
    if (!mb || typeof mb === 'boolean' || mb.exists === 0) return out
    for await (const msg of client.fetch('1:*', { uid: true, labels: true }, { uid: true })) {
      if (msg.labels) out.set(msg.uid, [...msg.labels])
    }
  } finally {
    lock.release()
  }
  return out
}

/** Add or remove one IMAP flag, or with `useLabels` one Gmail label, on a message by UID. */
export async function storeFlag(
  client: ImapFlow,
  path: string,
  uid: number,
  flag: string,
  add: boolean,
  useLabels = false
): Promise<void> {
  const lock = await client.getMailboxLock(path)
  try {
    // imapflow returns false instead of throwing on a NO/BAD reply (or no
    // X-GM-EXT-1), so a rejected STORE would otherwise look like success.
    const ok = add
      ? await client.messageFlagsAdd(String(uid), [flag], { uid: true, useLabels })
      : await client.messageFlagsRemove(String(uid), [flag], { uid: true, useLabels })
    if (!ok) {
      throw Object.assign(new Error(`STORE ${useLabels ? 'X-GM-LABELS' : 'FLAGS'} rejected`), {
        responseStatus: 'NO'
      })
    }
  } finally {
    lock.release()
  }
}

/** The mailbox was renumbered since the uid was captured, so it names another message. */
export class UidValidityChanged extends Error {
  constructor(path: string) {
    super(`UIDVALIDITY of "${path}" changed`)
  }
}

/** MOVE one UID from source mailbox to destination path. */
export async function moveUid(
  client: ImapFlow,
  fromPath: string,
  uid: number,
  toPath: string,
  expectedUidValidity: number | null = null
): Promise<void> {
  const lock = await client.getMailboxLock(fromPath)
  try {
    if (
      expectedUidValidity !== null &&
      Number((client.mailbox as { uidValidity?: bigint | number }).uidValidity) !==
        expectedUidValidity
    ) {
      throw new UidValidityChanged(fromPath)
    }
    const r = await client.messageMove(String(uid), toPath, { uid: true })
    // imapflow returns false instead of throwing. On a dead connection that
    // is a transient failure the queue must retry; on a live one the server
    // said NO or the uid is already gone, and retrying cannot help.
    if (r === false && !client.usable) throw new Error('connection lost during MOVE')
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
