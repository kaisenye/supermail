import { parseJsonReply } from '../services/ai/json.js'
import type { Ai } from '../services/ai/service.js'
import type { AiRequest } from '../services/ai/types.js'
import { LABEL_BACKFILL_MS, listAiLabels, setMessageLabels, type AiLabel } from '../store/aiLabels.js'
import { getMessage } from '../store/repo.js'
import type { Candidate } from './eligibility.js'
import { asData, MAIL_IS_DATA, messageText, who } from './mailText.js'

/**
 * The user's own labels (Settings → AI). Only a label someone defined is ever
 * applied; the fixed categories are the classifier's (classify.ts). Unlike the
 * classifier this looks at bulk mail too, since "Receipts" or "Newsletters I
 * read" are what people make labels for.
 */
export function labelsEligible(c: Candidate, now: number): boolean {
  return (
    !!c.message_id &&
    c.role === 'inbox' &&
    (c.from_addr ?? '').toLowerCase() !== c.me &&
    (c.date ?? 0) >= now - LABEL_BACKFILL_MS
  )
}

export function labelsSchema(labels: Pick<AiLabel, 'name'>[]) {
  return {
    name: 'labels',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['labels'],
      properties: {
        labels: { type: 'array', items: { type: 'string', enum: labels.map((l) => l.name) } }
      }
    }
  }
}

export function labelsRequest(
  labels: Pick<AiLabel, 'name' | 'description'>[],
  m: { from: string; subject: string | null; body: string }
): AiRequest {
  return {
    system: [
      'You file incoming email under the labels one person defined.',
      'Each label has a description of the mail that belongs under it. Give every label whose description fits this message; a message can fit several, and usually fits none.',
      'Only use the exact label names given. When unsure, leave a label out.',
      MAIL_IS_DATA
    ].join(' '),
    prompt: [
      'Labels:',
      ...labels.map((l) => `- ${l.name}: ${asData(l.description)}`),
      '',
      `From: ${m.from}`,
      `Subject: ${m.subject ?? '(none)'}`,
      '',
      `<message>\n${asData(m.body)}\n</message>`
    ].join('\n'),
    maxTokens: 400,
    schema: labelsSchema(labels)
  }
}

/** The label names in a reply, kept only when they are one of `labels` (any case). */
export function parseLabels(text: string, labels: Pick<AiLabel, 'id' | 'name'>[]): number[] {
  const o = parseJsonReply(text)
  const names = Array.isArray(o.labels) ? o.labels.filter((x): x is string => typeof x === 'string') : []
  const byName = new Map(labels.map((l) => [l.name.toLowerCase(), l.id]))
  return [...new Set(names.flatMap((n) => byName.get(n.trim().toLowerCase()) ?? []))]
}

/**
 * Files one stored message under the account's labels and saves the answer.
 * False when the account has no labels (nothing to ask). Background work:
 * it runs under the classifier's switch and counts against 80 % of the budget.
 */
export async function labelMessage(ai: Ai, messageRowId: number): Promise<boolean> {
  const m = getMessage(messageRowId)
  if (!m?.message_id) return false
  const labels = listAiLabels(m.account_id)
  if (!labels.length) return false
  const r = await ai.run(
    'classify',
    labelsRequest(labels, { from: who(m), subject: m.subject, body: messageText(m, 2000) }),
    { background: true }
  )
  // Switched off while the provider was answering: its verdicts were cleared.
  if (!ai.status().features.classify) return false
  // Read again: a label deleted meanwhile must not come back.
  setMessageLabels(m.account_id, m.message_id, parseLabels(r.text, listAiLabels(m.account_id)))
  return true
}
