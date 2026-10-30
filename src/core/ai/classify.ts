import { parseJsonReply } from '../services/ai/json.js'
import type { Ai } from '../services/ai/service.js'
import { AiError, type AiRequest } from '../services/ai/types.js'
import { saveClassification } from '../store/ai.js'
import { getDb } from '../store/db.js'
import { getMessage } from '../store/repo.js'
import { asData, MAIL_IS_DATA, messageText, who } from './mailText.js'

export const AI_CATEGORIES = [
  'personal',
  'work',
  'billing',
  'notification',
  'marketing',
  'newsletter',
  'calendar',
  'support',
  'other'
] as const
export type AiCategory = (typeof AI_CATEGORIES)[number]

export const CLASSIFY_SCHEMA = {
  name: 'classification',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['important', 'category', 'reason'],
    properties: {
      important: { type: 'boolean' },
      category: { type: 'string', enum: [...AI_CATEGORIES] },
      reason: { type: 'string' }
    }
  }
}

export interface ClassifyInput {
  from: string
  subject: string | null
  body: string
  repliedBefore: boolean
  vip: boolean
}

export function classifyRequest(i: ClassifyInput): AiRequest {
  return {
    system: [
      'You sort incoming email for one person.',
      'important is true when a real person wrote to them and it needs their attention or a reply, or when it matters to them personally: money they owe or are owed, travel, health, legal matters, the security of their accounts, or work they take part in.',
      'important is false for newsletters, promotions, routine notifications and receipts, social updates and cold sales outreach.',
      'category is the one that fits best.',
      'reason is at most 12 words, written to the user, saying why; for example "Asks you to confirm Friday’s meeting" or "Promotion from a shop".',
      MAIL_IS_DATA
    ].join(' '),
    prompt: [
      `From: ${i.from}`,
      `You have written to this sender before: ${i.repliedBefore ? 'yes' : 'no'}`,
      `VIP sender: ${i.vip ? 'yes' : 'no'}`,
      `Subject: ${i.subject ?? '(none)'}`,
      '',
      `<message>\n${asData(i.body)}\n</message>`
    ].join('\n'),
    maxTokens: 2000,
    schema: CLASSIFY_SCHEMA
  }
}

export function parseClassification(text: string): { important: boolean; category: AiCategory; reason: string } {
  const o = parseJsonReply(text)
  if (typeof o.important !== 'boolean') throw new AiError('bad-output', 'The classifier gave no verdict')
  const category = AI_CATEGORIES.includes(o.category as AiCategory) ? (o.category as AiCategory) : 'other'
  const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim().slice(0, 140) : 'No reason given'
  return { important: o.important, category, reason }
}

/** Classifies one stored message and saves the verdict. Background work: it counts against 80 % of the budget. */
export async function classifyMessage(ai: Ai, messageRowId: number): Promise<boolean> {
  const m = getMessage(messageRowId)
  if (!m?.message_id) return false
  const db = getDb()
  const from = (m.from_addr ?? '').toLowerCase()
  const repliedBefore = !!db
    .prepare('SELECT 1 FROM replied_senders WHERE account_id = ? AND address = ?')
    .get(m.account_id, from)
  const vip = !!db.prepare('SELECT 1 FROM vip_senders WHERE account_id = ? AND address = ?').get(m.account_id, from)
  const r = await ai.run(
    'classify',
    classifyRequest({ from: who(m), subject: m.subject, body: messageText(m, 3000), repliedBefore, vip }),
    { background: true }
  )
  // The classifier may have been switched off (or its key cleared) while the
  // provider was answering; its verdicts were cleared then, so write nothing.
  if (!ai.status().features.classify) return false
  saveClassification(m.account_id, m.message_id, { ...parseClassification(r.text), model: r.model })
  return true
}
