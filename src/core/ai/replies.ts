import { parseJsonReply } from '../services/ai/json.js'
import type { Ai } from '../services/ai/service.js'
import { AiError, type AiRequest } from '../services/ai/types.js'
import { getReplyOptions, saveReplyOptions } from '../store/ai.js'
import { getDb } from '../store/db.js'
import { getMessage, getSettings, getThread } from '../store/repo.js'
import { MAIL_IS_DATA, transcript } from './mailText.js'

export const REPLIES_SCHEMA = {
  name: 'replies',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['options'],
    properties: { options: { type: 'array', items: { type: 'string' } } }
  }
}

export function repliesRequest(i: { thread: string; me: string; myName: string | null }): AiRequest {
  return {
    system: [
      `Suggest three short replies that the user (${i.myName ? `${i.myName} <${i.me}>` : i.me}) could send to the latest message in this conversation.`,
      'Each is a complete email body of one or two sentences, in the language of the conversation.',
      'Make them meaningfully different: for example yes, no or not now, and a question back.',
      'No greeting placeholders like [Name], no signature.',
      MAIL_IS_DATA
    ].join(' '),
    prompt: `The conversation, oldest first:\n${i.thread}`,
    maxTokens: 2000,
    schema: REPLIES_SCHEMA
  }
}

export function parseReplyOptions(text: string): string[] {
  const o = parseJsonReply(text)
  const options = (Array.isArray(o.options) ? o.options : [])
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().slice(0, 400))
    .filter(Boolean)
    .slice(0, 3)
  if (!options.length) throw new AiError('bad-output', 'The model suggested no replies')
  return options
}

/** Suggestions for one message, from the cache or the model (then cached, keyed by Message-ID). */
export async function suggestReplies(ai: Ai, messageRowId: number, opts: { background: boolean }): Promise<string[]> {
  const m = getMessage(messageRowId)
  if (!m?.message_id) throw new AiError('invalid', 'This message cannot get suggestions')
  const cached = getReplyOptions(m.account_id, m.message_id)
  if (cached) return cached
  // The message and up to five before it; later replies are not what it answers.
  const msgs = m.thread_id
    ? getThread(m.account_id, m.thread_id)
        .filter((x) => (x.date ?? 0) <= (m.date ?? 0))
        .slice(0, 6)
    : [m]
  const acct = getDb().prepare('SELECT email FROM accounts WHERE id = ?').get(m.account_id) as
    | { email: string }
    | undefined
  // The From: name, under accounts/manage.ts displayNameKey(). Read directly:
  // manage.ts loads the Electron vault at import time, which core tests cannot.
  const myName = getSettings()[`account.${m.account_id}.name`] || null
  const r = await ai.run(
    'replies',
    repliesRequest({ thread: transcript(msgs.length ? msgs : [m]), me: acct?.email ?? '', myName }),
    { background: opts.background }
  )
  const options = parseReplyOptions(r.text)
  saveReplyOptions(m.account_id, m.message_id, options, r.model)
  return options
}

const inflight = new Map<string, Promise<string[]>>()

/**
 * suggestReplies, but a second request for a message already being answered
 * (StrictMode double effect, j/k back to it, the worker's job racing the
 * on-demand call) joins the first instead of paying the provider again.
 * Keyed by Message-ID so two folder copies of one message share a call.
 */
export function suggestRepliesOnce(ai: Ai, messageRowId: number, opts: { background: boolean }): Promise<string[]> {
  const m = getMessage(messageRowId)
  const k = m?.message_id ? `${m.account_id}:${m.message_id}` : `row:${messageRowId}`
  const running = inflight.get(k)
  if (running) return running
  const p = suggestReplies(ai, messageRowId, opts).finally(() => inflight.delete(k))
  inflight.set(k, p)
  return p
}
