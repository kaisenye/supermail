import { AI_FEATURES, AI_PROVIDERS, type AiFeature, type AiProviderId } from './types.js'

/** Sonnet 5.5 (Anthropic) and GPT-6.1 Sol (OpenAI): current, same price tier. Editable in Settings. */
export const DEFAULT_MODELS: Record<AiProviderId, string> = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-6.1-sol'
}
export const DEFAULT_BUDGET_USD = 1
export const MAX_BUDGET_USD = 100

export const AI_KEYS = {
  provider: 'ai_provider',
  budget: 'ai_daily_budget_usd',
  model: (p: AiProviderId) => `ai_model_${p}`,
  feature: (f: AiFeature) => `ai_${f}`
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/

export interface AiSettings {
  provider: AiProviderId
  /** Effective model per provider: the stored one, or the default. */
  models: Record<AiProviderId, string>
  budgetUsd: number
  /** What the user switched on. Main still needs a key before a feature runs. */
  toggles: Record<AiFeature, boolean>
}

const isProvider = (v: unknown): v is AiProviderId => AI_PROVIDERS.includes(v as AiProviderId)
const isFeature = (v: unknown): v is AiFeature => AI_FEATURES.includes(v as AiFeature)

export function readAiSettings(s: Record<string, string>): AiSettings {
  const p = s[AI_KEYS.provider]
  const provider: AiProviderId = isProvider(p) ? p : 'anthropic'
  const models = Object.fromEntries(
    AI_PROVIDERS.map((id) => {
      const m = (s[AI_KEYS.model(id)] ?? '').trim()
      return [id, MODEL_RE.test(m) ? m : DEFAULT_MODELS[id]]
    })
  ) as Record<AiProviderId, string>
  const raw = s[AI_KEYS.budget]
  const n = raw === undefined || raw === '' ? DEFAULT_BUDGET_USD : Number(raw)
  const budgetUsd = Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_BUDGET_USD) : DEFAULT_BUDGET_USD
  const toggles = Object.fromEntries(AI_FEATURES.map((f) => [f, s[AI_KEYS.feature(f)] === '1'])) as Record<
    AiFeature,
    boolean
  >
  return { provider, models, budgetUsd, toggles }
}

/** What Settings → AI may change in one call. */
export interface AiConfigInput {
  provider?: AiProviderId
  /** An empty model resets that provider to its default. */
  model?: { provider: AiProviderId; model: string }
  budgetUsd?: number
  feature?: { feature: AiFeature; on: boolean }
}

/**
 * Validates a change from the renderer and returns the settings rows to write.
 * Throws a message fit for Settings. A feature can only be switched on while
 * the provider it will use has a key, and a provider change switches all off.
 */
export function aiConfigPatch(
  input: AiConfigInput,
  ctx: { provider: AiProviderId; hasKey: Record<AiProviderId, boolean> }
): Record<string, string> {
  const out: Record<string, string> = {}
  if (input.provider !== undefined) {
    if (!isProvider(input.provider)) throw new Error('Unknown AI provider')
    out[AI_KEYS.provider] = input.provider
    // Each vendor needs its own opt-in: switching provider turns every feature
    // off, so adding the new vendor's key later never sends mail on its own.
    if (input.provider !== ctx.provider) for (const f of AI_FEATURES) out[AI_KEYS.feature(f)] = '0'
  }
  if (input.model !== undefined) {
    if (!isProvider(input.model.provider)) throw new Error('Unknown AI provider')
    const m = String(input.model.model ?? '').trim()
    if (m && !MODEL_RE.test(m)) throw new Error('That is not a model id')
    out[AI_KEYS.model(input.model.provider)] = m
  }
  if (input.budgetUsd !== undefined) {
    const b = input.budgetUsd
    if (typeof b !== 'number' || !Number.isFinite(b) || b < 0 || b > MAX_BUDGET_USD)
      throw new Error(`The daily budget must be between $0 and $${MAX_BUDGET_USD}`)
    out[AI_KEYS.budget] = String(Math.round(b * 100) / 100)
  }
  if (input.feature !== undefined) {
    const { feature, on } = input.feature
    if (!isFeature(feature)) throw new Error('Unknown AI feature')
    const provider = input.provider ?? ctx.provider
    if (on && !ctx.hasKey[provider]) throw new Error('Add an API key first')
    out[AI_KEYS.feature(feature)] = on ? '1' : '0'
  }
  return out
}
