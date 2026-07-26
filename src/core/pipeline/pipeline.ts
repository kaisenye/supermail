import { getDb } from '../store/db.js'
import { upsertMessage } from '../store/repo.js'
import type { MsgCtx, Processor, RawMessage } from './types.js'

export interface PipelineResult {
  id: number | null
  errors: { processor: string; message: string }[]
}

function emptyDraft(raw: RawMessage): MsgCtx['draft'] {
  return {
    account_id: raw.accountId,
    folder_id: raw.folderId,
    uid: raw.uid,
    message_id: null,
    thread_id: null,
    in_reply_to: null,
    from_addr: null,
    from_name: null,
    to_addrs: '[]',
    cc_addrs: '[]',
    subject: null,
    date: null,
    snippet: null,
    flags: '[]'
  }
}

/**
 * Runs processors in order, then persists. A processor throwing is recorded
 * and skipped rather than dropping the message — a bad summarizer in stage 2
 * must never cost you mail.
 *
 * parse is the exception: without it there is no message to store.
 */
export async function runPipeline(
  raw: RawMessage,
  processors: Processor[]
): Promise<PipelineResult> {
  const ctx: MsgCtx = { raw, draft: emptyDraft(raw), attachments: [] }
  const errors: PipelineResult['errors'] = []

  for (const p of processors) {
    try {
      await p.run(ctx)
    } catch (e) {
      errors.push({ processor: p.name, message: (e as Error).message })
      if (p.name === 'parse') return { id: null, errors }
    }
  }

  const db = getDb()
  const id = db.transaction(() => {
    const msgId = upsertMessage(ctx.draft)
    if (ctx.attachments.length) {
      db.prepare('DELETE FROM attachments WHERE message_id = ?').run(msgId)
      const ins = db.prepare(
        `INSERT INTO attachments (message_id, filename, mime, size, part_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      for (const a of ctx.attachments) {
        ins.run(msgId, a.filename, a.mime, a.size, a.part_id)
      }
    }
    return msgId
  })()

  return { id, errors }
}
