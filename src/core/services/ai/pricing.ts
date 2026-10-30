import type { AiProviderId } from './types.js'

/**
 * US$ per million tokens, [input, output], standard tier.
 * Anthropic: the claude-api skill's model table (cached 2026-10-06).
 * OpenAI: developers.openai.com/api/docs/pricing, short context, read 2026-10-30.
 * Update both when a provider changes prices; the budget is only as good as this.
 */
export const PRICES: Record<AiProviderId, Record<string, [number, number]>> = {
  anthropic: {
    'claude-fable-5-1': [10, 50],
    'claude-fable-5': [10, 50],
    'claude-opus-5-5': [4, 20],
    'claude-opus-5': [5, 25],
    'claude-opus-4-8': [5, 25],
    'claude-opus-4-7': [5, 25],
    'claude-opus-4-6': [5, 25],
    'claude-sonnet-5-5': [2, 10],
    'claude-sonnet-5': [2, 10],
    'claude-sonnet-4-6': [3, 15],
    'claude-haiku-5-5': [0.1, 0.5],
    'claude-haiku-4-5': [1, 5]
  },
  openai: {
    'gpt-6-astra': [10, 50],
    'gpt-6.1-sol': [2, 10],
    'gpt-6.1-terra': [1, 5],
    'gpt-6-sol': [2, 10],
    'gpt-6-luna': [0.1, 0.5],
    'gpt-5.6-sol': [4, 20],
    'gpt-5.6-terra': [2, 12],
    'gpt-5.6-luna': [0.2, 1.2],
    'gpt-5.5': [5, 30],
    'gpt-5.4-mini': [0.75, 4.5],
    'gpt-5.4-nano': [0.2, 1.25]
  }
}

export function priceFor(provider: AiProviderId, model: string): [number, number] {
  const table = PRICES[provider]
  if (table[model]) return table[model]
  // A dated snapshot ("gpt-5.5-2026-04-23") prices as its family.
  const family = Object.keys(table)
    .filter((k) => model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0]
  if (family) return table[family]
  // Unknown model: count it at the dearest price, so the budget errs on the safe side.
  return Object.values(table).reduce((a, b) => (a[0] + a[1] >= b[0] + b[1] ? a : b))
}

/** A price in US$ per million tokens is micro-dollars per token. */
export function costMicros(provider: AiProviderId, model: string, inputTokens: number, outputTokens: number): number {
  const [i, o] = priceFor(provider, model)
  return Math.round(inputTokens * i + outputTokens * o)
}
