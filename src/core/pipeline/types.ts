import type { UpsertMessageInput } from '../store/types.js'

/** Raw input a processor starts from. Either envelope-only or with a full body. */
export interface RawMessage {
  accountId: number
  folderId: number | null
  uid: number | null
  /** Full RFC822 source. Absent on envelope-only sync passes. */
  source?: Buffer | string
  /** Pre-parsed envelope from IMAP FETCH, used when source is absent. */
  envelope?: {
    messageId?: string | null
    inReplyTo?: string | null
    references?: string[] | null
    from?: { address?: string; name?: string } | null
    to?: { address?: string; name?: string }[] | null
    cc?: { address?: string; name?: string }[] | null
    subject?: string | null
    date?: Date | null
  }
  flags?: string[]
}

/**
 * Mutable context threaded through processors. Each processor reads what it
 * needs and writes onto `draft`; the pipeline persists `draft` at the end.
 */
export interface MsgCtx {
  raw: RawMessage
  draft: UpsertMessageInput
  /** Attachment metadata discovered during parse; persisted after the message. */
  attachments: {
    filename: string | null
    mime: string | null
    size: number | null
    part_id: string | null
    /** 1 when the body references it via cid:, so the list can hide it. */
    inline?: number
    /** Raw bytes, written to disk by the pipeline. Absent on envelope-only passes. */
    content?: Buffer
  }[]
}

/**
 * Stage-1 registers parse + index. Stage 2 appends embed/summarize/classify
 * here with no change to the pipeline runner or the store.
 */
export interface Processor {
  name: string
  run(ctx: MsgCtx): Promise<void>
}
