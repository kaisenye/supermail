import { AiError } from './types.js'

/**
 * The JSON object in a structured-output reply. Providers enforce the schema,
 * but a fenced or chatty reply from an unconstrained model is tolerated.
 */
export function parseJsonReply(text: string): Record<string, unknown> {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start < 0 || end < start) throw new AiError('bad-output', 'The model did not return JSON')
  try {
    const v: unknown = JSON.parse(unfenced.slice(start, end + 1))
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new AiError('bad-output', 'The model returned malformed JSON')
}
