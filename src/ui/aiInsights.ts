import type { AiInsights } from '../../electron/preload'

/** Shown when ⌘K asks for a summary of a conversation that is too short to need one. */
export const TOO_SHORT_NOTE = 'Too short to summarize'

/** Run the summary on open: Summaries is on, nothing is cached, and the thread is worth one. */
export function shouldAutoSummarize(i: AiInsights | null): boolean {
  return !!i && i.features.summary && !i.summary && i.summarizable
}

/** Ask for Instant Replies on open: the feature is on, a message qualifies and none are cached. */
export function shouldAutoSuggest(i: AiInsights | null): boolean {
  return !!i && i.features.replies && i.replyTarget !== null && !i.replies
}

/**
 * A body just loaded in the thread view. Only a conversation that read as too
 * short is worth reading again: a lone message counts as short until its body
 * is stored, and may turn out long enough once it is.
 */
export function shouldRecheckOnBody(i: AiInsights | null): boolean {
  return !!i && i.features.summary && !i.summary && !i.summarizable
}

/** What a finished summary run leaves under the header besides the summary itself. */
export function summaryNote(manual: boolean, summary: string | null): string | null {
  return manual && summary === null ? TOO_SHORT_NOTE : null
}

/** An Instant Reply and the message it answers, which need not be the row the thread was opened on. */
export interface ReplyPick {
  text: string
  messageRowId: number
}

/** Instant Reply `i` (0-based) with its target message, or null when there is none. */
export function replyPick(i: AiInsights | null, index: number): ReplyPick | null {
  const r = i?.replies
  const text = r?.options[index]
  return r && text ? { text, messageRowId: r.messageRowId } : null
}

/**
 * The message a reply is built from. An Instant Reply was written for the newest
 * inbound message, so it answers that one, not the opened row (a Sent copy, or
 * an older search hit from someone else).
 */
export function replySourceId(openedMessageId: number, prefill?: ReplyPick): number {
  return prefill?.messageRowId ?? openedMessageId
}
