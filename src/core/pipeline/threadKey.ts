/**
 * Thread key derivation, shared by the parse pipeline and the rethread repair.
 *
 * Extracted so both agree: they disagreed once, and a conversation split in
 * half is the visible result.
 */

/** `<>` and blanks are not real ids: Zimbra emits an empty leading reference. */
export function validId(id: string | null | undefined): string | null {
  const t = id?.trim()
  if (!t || t === '<>' || t === '<' || t === '>') return null
  return t
}

/**
 * References[0] is the root of the conversation, so all replies agree on it
 * regardless of arrival order. Falls back through in-reply-to to the message's
 * own id (a new thread of one).
 */
export function threadKey(
  references: string[] | null | undefined,
  inReplyTo: string | null | undefined,
  messageId: string | null | undefined
): string | null {
  // First *valid* reference, not references[0]: Poltra's Zimbra prefixes the
  // header with `<>`, which would otherwise become the thread id for every
  // message that passes through it — collapsing unrelated mail into one thread
  // while splitting the real conversation.
  for (const r of references ?? []) {
    const v = validId(r)
    if (v) return v
  }
  return validId(inReplyTo) ?? validId(messageId) ?? null
}
