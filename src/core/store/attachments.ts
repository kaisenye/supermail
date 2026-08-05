import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { getDb } from './db.js'

/** Bigger than this and we keep the row but not the bytes — parse already holds it in RAM. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

const MAX_NAME_LEN = 120

let baseDir: string | null = null

/** Main injects the store root (same DI shape as initDb), core never imports electron. */
export function initAttachmentStore(dir: string): string {
  baseDir = join(dir, 'attachments')
  mkdirSync(baseDir, { recursive: true })
  return baseDir
}

function getBaseDir(): string {
  if (!baseDir) throw new Error('attachment store not initialized — call initAttachmentStore first')
  return baseDir
}

/**
 * Filenames come off the wire attacker-controlled: strip directory components,
 * null bytes and separators so a name can never escape the message's own folder.
 */
export function safeFilename(name: string | null): string {
  const raw = (name ?? '').replace(/\0/g, '')
  // basename() on both separators kills ../, C:\ and /abs paths alike.
  const flat = basename(raw.replace(/\\/g, '/')).replace(/[/\\]/g, '')
  const cleaned = flat.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '')
  if (!cleaned) return 'attachment'
  if (cleaned.length <= MAX_NAME_LEN) return cleaned
  const dot = cleaned.lastIndexOf('.')
  const ext = dot > 0 ? cleaned.slice(dot, dot + 16) : ''
  return cleaned.slice(0, MAX_NAME_LEN - ext.length) + ext
}

function messageDir(messageId: number): string {
  return join(getBaseDir(), String(messageId))
}

/** Mirrors the attachment-row DELETE so a re-fetch never orphans old files. */
export function clearMessageAttachments(messageId: number): void {
  rmSync(messageDir(messageId), { recursive: true, force: true })
}

/**
 * Writes one attachment under <base>/<messageId>/<index>-<safe name>. The index
 * prefix keeps two attachments with the same filename from colliding.
 */
export function writeAttachment(
  messageId: number,
  index: number,
  filename: string | null,
  content: Buffer
): string | null {
  if (content.length > MAX_ATTACHMENT_BYTES) return null
  const dir = messageDir(messageId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${index}-${safeFilename(filename)}`)
  writeFileSync(path, content)
  return path
}

/** Signature logo lives outside the per-message tree; there is only ever one. */
export function signatureLogoPath(ext: string): string {
  return join(getBaseDir(), `signature-logo${ext}`)
}

/** Resolves a stored attachment to its absolute path; null if it has no bytes. */
export function attachmentPath(attachmentId: number): string | null {
  const row = getDb()
    .prepare('SELECT storage_path FROM attachments WHERE id = ?')
    .get(attachmentId) as { storage_path: string | null } | undefined
  return row?.storage_path ?? null
}
