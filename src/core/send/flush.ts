import { formatFromHeader, type AccountConfig } from '../accounts/config.js'
import { createClient } from '../sync/imap.js'
import { deleteDraft, findFolderByPath, getMessage } from '../store/repo.js'
import {
  getOutbox,
  listDueOutbox,
  markOutboxFailed,
  markOutboxSending,
  markOutboxSent,
  type OutboxRow
} from './outbox.js'
import { sendSmtp } from './smtp.js'

const SENT_PATHS = ['Sent Messages', 'Sent', 'INBOX.Sent']

function buildRawMime(from: string, row: OutboxRow, messageId: string): string {
  const lines = [
    `From: ${from}`,
    `To: ${row.to_addrs}`,
    row.cc_addrs ? `Cc: ${row.cc_addrs}` : null,
    `Subject: ${row.subject ?? ''}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    row.in_reply_to ? `In-Reply-To: ${row.in_reply_to}` : null,
    row.references_header ? `References: ${row.references_header}` : null,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    row.body_text ?? ''
  ]
  return lines.filter((l) => l !== null).join('\r\n')
}

async function appendToSent(
  config: AccountConfig,
  row: OutboxRow,
  messageId: string
): Promise<void> {
  const client = createClient(config)
  try {
    await client.connect()
    let path: string | null = null
    for (const p of SENT_PATHS) {
      if (findFolderByPath(row.account_id, p)) {
        path = p
        break
      }
    }
    if (!path) path = 'Sent Messages'
    const raw = Buffer.from(buildRawMime(formatFromHeader(config), row, messageId), 'utf8')
    await client.append(path, raw, ['\\Seen'])
  } finally {
    try {
      await client.logout()
    } catch {
      /* ignore */
    }
  }
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
    const result = await sendSmtp(config, {
      to: row.to_addrs,
      cc: row.cc_addrs ?? undefined,
      bcc: row.bcc_addrs ?? undefined,
      subject: row.subject ?? '',
      text: row.body_text ?? '',
      html: row.body_html ?? undefined,
      inReplyTo: row.in_reply_to,
      references: row.references_header,
      messageId
    })
    try {
      await appendToSent(config, row, result.messageId || messageId)
    } catch {
      // Sent APPEND is best-effort; SMTP already succeeded.
    }
    if (row.draft_message_id) {
      const draft = getMessage(row.draft_message_id)
      if (draft?.folder_id == null) deleteDraft(row.draft_message_id)
    }
    markOutboxSent(row.id)
    return { ok: true }
  } catch (e) {
    const msg = (e as Error).message
    markOutboxFailed(row.id, msg)
    return { ok: false, error: msg }
  }
}

export async function flushDueOutbox(config: AccountConfig): Promise<number> {
  const due = listDueOutbox()
  let sent = 0
  for (const row of due) {
    // Re-read in case cancelled between list and flush.
    const current = getOutbox(row.id)
    if (!current || current.status !== 'pending') continue
    const res = await flushOutboxRow(config, current)
    if (res.ok) sent++
  }
  return sent
}

let workerTimer: ReturnType<typeof setInterval> | null = null

export function startOutboxWorker(
  getConfig: () => AccountConfig | null,
  intervalMs = 5_000
): void {
  if (workerTimer) return
  workerTimer = setInterval(() => {
    const config = getConfig()
    if (!config) return
    void flushDueOutbox(config)
  }, intervalMs)
}

export function stopOutboxWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer)
    workerTimer = null
  }
}
