import { readFileSync } from 'fs'
import { formatFromHeader, type AccountConfig } from '../accounts/config.js'
import { getPool } from '../sync/pool.js'
import { deleteDraft, findFolderByPath, getMessage } from '../store/repo.js'
import {
  getOutbox,
  listDueOutbox,
  markOutboxFailed,
  markOutboxSending,
  markOutboxSent,
  type OutboxRow
} from './outbox.js'
import {
  buildMime,
  htmlToPlainText,
  type MimeAttachment,
  type MimeInlineImage
} from './mime.js'
import { sendSmtp, type OutboundAttachment } from './smtp.js'

const SENT_PATHS = ['Sent Messages', 'Sent', 'INBOX.Sent']

/** Plain part is never empty: fall back to a downgrade of the HTML. */
function plainBody(row: OutboxRow): string {
  const text = row.body_text?.trim()
  if (text) return text
  return row.body_html ? htmlToPlainText(row.body_html) : ''
}

/** Outbox stores attachment metadata as JSON; bytes stay on disk until send. */
function readAttachments(row: OutboxRow): OutboundAttachment[] {
  const raw = row.attachments
  if (!raw) return []
  // Throwing fails the row. Returning [] would send a stripped message and
  // report success — the exact silent-drop this path already got wrong once.
  const parsed = JSON.parse(raw) as OutboundAttachment[]
  if (!Array.isArray(parsed) || parsed.some((a) => !a?.path)) {
    throw new Error('outbox attachment metadata is corrupt')
  }
  return parsed
}

/** The Sent copy inlines bytes; a file gone missing must not fail the APPEND. */
function loadForMime(attachments: OutboundAttachment[]): MimeAttachment[] {
  const out: MimeAttachment[] = []
  for (const a of attachments) {
    try {
      out.push({ ...a, content: readFileSync(a.path) })
    } catch (err) {
      // Silently dropping an attachment looks like a successful send.
      console.error(`[outbox] attachment unreadable, not sent: ${a.path}`, err)
    }
  }
  return out
}

/**
 * The editor stores inline images as data: URLs so it can display them, but
 * Outlook and Gmail's web client refuse those on the wire. Lift each one into
 * its own MIME part and point the HTML at it with cid:.
 */
export function extractInlineImages(html: string | null): {
  html: string | null
  inline: MimeInlineImage[]
} {
  if (!html || !html.includes('data:image/')) return { html, inline: [] }
  const inline: MimeInlineImage[] = []
  let n = 0

  const out = html.replace(
    /(<img\b[^>]*\bsrc=")data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)(")/gi,
    (_m, pre: string, mime: string, b64: string, post: string) => {
      n++
      const contentId = `sig${n}@supermail`
      const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'
      inline.push({
        contentId,
        filename: `image${n}.${ext}`,
        contentType: mime,
        content: Buffer.from(b64, 'base64')
      })
      return `${pre}cid:${contentId}${post}`
    }
  )
  return { html: out, inline }
}

/**
 * Some servers (Exmail among them) save the outgoing message to Sent as part
 * of SMTP, then refuse an explicit APPEND. That refusal means "already done".
 */
function isAlreadySavedBySmtp(err: unknown): boolean {
  const text = String(
    (err as { responseText?: string })?.responseText ?? (err as Error)?.message ?? ''
  )
  return /saved by smtp/i.test(text)
}

async function appendToSent(
  config: AccountConfig,
  row: OutboxRow,
  messageId: string,
  attachments: MimeAttachment[]
): Promise<void> {
  // APPEND takes an explicit mailbox, so it needs no SELECT at all.
  let path: string | null = null
  for (const p of SENT_PATHS) {
    if (findFolderByPath(row.account_id, p)) {
      path = p
      break
    }
  }
  if (!path) path = 'Sent Messages'
  const { html, inline } = extractInlineImages(row.body_html)
  const mime = buildMime({
    from: formatFromHeader(config),
    to: row.to_addrs,
    cc: row.cc_addrs,
    // Bcc is deliberately omitted: the Sent copy must not leak blind recipients.
    subject: row.subject ?? '',
    text: plainBody(row),
    html,
    inReplyTo: row.in_reply_to,
    references: row.references_header,
    messageId,
    attachments,
    inline
  })
  await getPool(config).withConnection((client) =>
    client.append(path as string, Buffer.from(mime, 'utf8'), ['\\Seen'])
  )
}

export async function flushOutboxRow(
  config: AccountConfig,
  row: OutboxRow
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!markOutboxSending(row.id)) {
    return { ok: false, error: 'not pending' }
  }
  try {
    const messageId = `<supermail-${row.id}-${Date.now()}@local>`
    const attachments = readAttachments(row)
    const { html, inline } = extractInlineImages(row.body_html)
    const result = await sendSmtp(config, {
      to: row.to_addrs,
      cc: row.cc_addrs ?? undefined,
      bcc: row.bcc_addrs ?? undefined,
      subject: row.subject ?? '',
      text: plainBody(row),
      html: html ?? undefined,
      inReplyTo: row.in_reply_to,
      references: row.references_header,
      messageId,
      attachments,
      inline
    })
    // Mark sent as soon as SMTP succeeds: the mail is irreversibly out.
    markOutboxSent(row.id)

    // Only APPEND when the server does NOT file sent mail itself. Exmail (and
    // most SMTP-with-save hosts) already store a copy, so appending puts two
    // in Sent. Verified against Exmail: SMTP alone produces exactly one copy.
    if (!config.smtpSavesSent) {
      try {
        await appendToSent(config, row, result.messageId || messageId, loadForMime(attachments))
      } catch (err) {
        // Best-effort: SMTP already succeeded, so this must not fail the send
        // — but it must not be silent either.
        if (!isAlreadySavedBySmtp(err)) {
          console.error('[outbox] Sent APPEND failed:', err)
        }
      }
    }

    if (row.draft_message_id) {
      const draft = getMessage(row.draft_message_id)
      if (draft?.folder_id == null) deleteDraft(row.draft_message_id)
    }
    return { ok: true }
  } catch (e) {
    const msg = (e as Error).message
    markOutboxFailed(row.id, msg)
    return { ok: false, error: msg }
  }
}

export interface SendFailure {
  outboxId: number
  subject: string | null
  to: string
  error: string
}

export async function flushDueOutbox(
  config: AccountConfig,
  onFailure?: (f: SendFailure) => void
): Promise<number> {
  const due = listDueOutbox()
  let sent = 0
  for (const row of due) {
    // Re-read in case cancelled between list and flush.
    const current = getOutbox(row.id)
    if (!current || current.status !== 'pending') continue
    const res = await flushOutboxRow(config, current)
    if (res.ok) sent++
    // A failed send is otherwise invisible: the compose window is already gone.
    else
      onFailure?.({
        outboxId: current.id,
        subject: current.subject,
        to: current.to_addrs,
        error: res.error
      })
  }
  return sent
}

let workerTimer: ReturnType<typeof setInterval> | null = null

// Must stay under the compose send delay, or a "send now" waits on the poll
// rather than on its own undo window.
export function startOutboxWorker(
  getConfig: () => AccountConfig | null,
  intervalMs = 1_000,
  onFailure?: (f: SendFailure) => void
): void {
  if (workerTimer) return
  // A flush takes seconds (SMTP + Sent APPEND) but the tick is 1s, so without
  // this guard ticks overlap and a single row can be appended to Sent twice.
  let running = false
  workerTimer = setInterval(() => {
    if (running) return
    const config = getConfig()
    if (!config) return
    running = true
    void flushDueOutbox(config, onFailure).finally(() => {
      running = false
    })
  }, intervalMs)
}

export function stopOutboxWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer)
    workerTimer = null
  }
}
