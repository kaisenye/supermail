import { simpleParser } from 'mailparser'
import type { MsgCtx, Processor } from './types.js'

const SNIPPET_LEN = 140

/** Collapse quoted replies/signatures out of the snippet preview. */
function toSnippet(text: string | null | undefined): string | null {
  if (!text) return null
  const cleaned = text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('>'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned ? cleaned.slice(0, SNIPPET_LEN) : null
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Thread key. References[0] is the root of the conversation, so all replies
 * agree on it regardless of arrival order. Falls back through in-reply-to to
 * the message's own id (a new thread of one).
 */
function threadKey(
  references: string[] | null | undefined,
  inReplyTo: string | null | undefined,
  messageId: string | null | undefined
): string | null {
  return references?.[0] ?? inReplyTo ?? messageId ?? null
}

function addrList(
  list: { address?: string; name?: string }[] | null | undefined
): string {
  return JSON.stringify(
    (list ?? []).map((a) => ({ address: a.address ?? null, name: a.name ?? null }))
  )
}

export const parseProcessor: Processor = {
  name: 'parse',
  async run(ctx: MsgCtx): Promise<void> {
    const { raw, draft } = ctx
    // Flags come from the IMAP FETCH, never from RFC822 source. Leaving this
    // undefined on a body-only pass preserves the stored \Seen/\Flagged state.
    draft.flags = raw.flags ? JSON.stringify(raw.flags) : null

    if (raw.source) {
      const p = await simpleParser(raw.source)
      const from = p.from?.value?.[0]
      const refs =
        typeof p.references === 'string' ? [p.references] : (p.references ?? null)

      draft.message_id = p.messageId ?? null
      draft.in_reply_to = p.inReplyTo ?? null
      draft.thread_id = threadKey(refs, p.inReplyTo, p.messageId)
      draft.from_addr = from?.address ?? null
      draft.from_name = from?.name || null
      draft.to_addrs = addrList(p.to && 'value' in p.to ? p.to.value : [])
      draft.cc_addrs = addrList(p.cc && 'value' in p.cc ? p.cc.value : [])
      draft.subject = p.subject ?? null
      draft.date = p.date ? p.date.getTime() : null
      draft.body_text = p.text ?? null
      draft.body_html = typeof p.html === 'string' ? p.html : null
      draft.body_fetched = 1

      // Prefer real text; fall back to stripped html so html-only mail still previews.
      draft.snippet = toSnippet(p.text ?? (p.html ? stripHtml(p.html) : null))

      const atts = (p.attachments ?? []).filter((a) => a.contentDisposition !== 'inline')
      draft.has_attachments = atts.length > 0 ? 1 : 0
      ctx.attachments = atts.map((a) => ({
        filename: a.filename ?? null,
        mime: a.contentType ?? null,
        size: a.size ?? null,
        part_id: null
      }))
      return
    }

    // Envelope-only pass: no body, so the list can render before bodies arrive.
    const e = raw.envelope
    if (!e) throw new Error('parse: message has neither source nor envelope')

    draft.message_id = e.messageId ?? null
    draft.in_reply_to = e.inReplyTo ?? null
    draft.thread_id = threadKey(e.references, e.inReplyTo, e.messageId)
    draft.from_addr = e.from?.address ?? null
    draft.from_name = e.from?.name || null
    draft.to_addrs = addrList(e.to)
    draft.cc_addrs = addrList(e.cc)
    draft.subject = e.subject ?? null
    draft.date = e.date ? e.date.getTime() : null
    draft.body_fetched = 0
  }
}
