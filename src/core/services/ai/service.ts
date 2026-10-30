import { costMicros } from './pricing.js'
import { DEFAULT_MODELS, readAiSettings } from './settings.js'
import {
  AI_FEATURES,
  AI_PROVIDERS,
  AiError,
  type AiFeature,
  type AiProvider,
  type AiProviderId,
  type AiRequest,
  type AiResult,
  type AiUsage
} from './types.js'

export interface UsageRecord {
  day: string
  provider: AiProviderId
  model: string
  feature: AiFeature
  inputTokens: number
  outputTokens: number
  costMicros: number
}

/** Where spend is kept (src/core/store/ai.ts in the app, a stub in tests). */
export interface UsageStore {
  spentMicros(day: string): number
  record(u: UsageRecord): void
}

export interface AiDeps {
  settings: () => Record<string, string>
  /** Reads the vault. Null when no key is saved. */
  key: (provider: AiProviderId) => string | null
  providers: Record<AiProviderId, AiProvider>
  usage: UsageStore
  now?: () => number
}

export interface AiStatus {
  provider: AiProviderId
  models: Record<AiProviderId, string>
  defaultModels: Record<AiProviderId, string>
  hasKey: Record<AiProviderId, boolean>
  budgetUsd: number
  spentTodayUsd: number
  /** What the user switched on. */
  toggles: Record<AiFeature, boolean>
  /** What actually runs: switched on, and the active provider has a key. */
  features: Record<AiFeature, boolean>
}

export interface RunOptions {
  /** Precomputed work: stops at BACKGROUND_SHARE of the budget. */
  background?: boolean
  signal?: AbortSignal
}

export interface Ai {
  status(): AiStatus
  run(feature: AiFeature, req: AiRequest, opts?: RunOptions): Promise<AiResult>
}

/** Background work leaves the last 20 % of the day's budget to what the user asks for. */
export const BACKGROUND_SHARE = 0.8

const PROVIDER_LABEL: Record<AiProviderId, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }
const FEATURE_LABEL: Record<AiFeature, string> = {
  write: 'Write with AI',
  replies: 'Instant Reply',
  summary: 'Summaries',
  classify: 'Important / Other sorting',
  ask: 'Ask AI'
}

/** Local calendar day, YYYY-MM-DD: the budget resets at local midnight. */
export function localDay(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Why a feature cannot run, or null when it can. The one place the
 * disabled / no-key errors are worded, so a cached result can be refused the
 * same way a provider call is.
 */
export function featureGate(
  toggles: Record<AiFeature, boolean>,
  provider: AiProviderId,
  hasKey: boolean,
  feature: AiFeature
): AiError | null {
  if (!toggles[feature]) return new AiError('disabled', `${FEATURE_LABEL[feature]} is off in Settings → AI`)
  if (!hasKey) return new AiError('no-key', `Add your ${PROVIDER_LABEL[provider]} key in Settings → AI`)
  return null
}

/** The gate for a status snapshot. */
export function statusGate(st: AiStatus, feature: AiFeature): AiError | null {
  return featureGate(st.toggles, st.provider, st.hasKey[st.provider], feature)
}

/** Removes the key from any text that might reach the UI or a log. */
export function scrub(text: string, secret: string | null): string {
  return secret && secret.length >= 8 ? text.split(secret).join('[key]') : text
}

export function createAi(deps: AiDeps): Ai {
  const now = deps.now ?? Date.now

  const status = (): AiStatus => {
    const s = readAiSettings(deps.settings())
    const hasKey = Object.fromEntries(AI_PROVIDERS.map((p) => [p, deps.key(p) !== null])) as Record<
      AiProviderId,
      boolean
    >
    const features = Object.fromEntries(
      AI_FEATURES.map((f) => [f, s.toggles[f] && hasKey[s.provider]])
    ) as Record<AiFeature, boolean>
    return {
      provider: s.provider,
      models: s.models,
      defaultModels: DEFAULT_MODELS,
      hasKey,
      budgetUsd: s.budgetUsd,
      spentTodayUsd: deps.usage.spentMicros(localDay(now())) / 1e6,
      toggles: s.toggles,
      features
    }
  }

  return {
    status,
    async run(feature, req, opts = {}) {
      const s = readAiSettings(deps.settings())
      const key = deps.key(s.provider)
      const blocked = featureGate(s.toggles, s.provider, key !== null, feature)
      if (blocked || !key) throw blocked ?? new AiError('no-key', 'No key')
      const day = localDay(now())
      const cap = Math.round(s.budgetUsd * 1e6 * (opts.background ? BACKGROUND_SHARE : 1))
      if (deps.usage.spentMicros(day) >= cap)
        throw new AiError('budget', 'Today’s AI budget is used up. Raise it in Settings → AI, or wait until tomorrow.')
      const model = s.models[s.provider]
      const record = (u: AiUsage): void => {
        const used = u.model || model
        deps.usage.record({
          day,
          provider: s.provider,
          model: used,
          feature,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          costMicros: costMicros(s.provider, used, u.inputTokens, u.outputTokens)
        })
      }
      let r: AiResult
      try {
        r = await deps.providers[s.provider].complete(req, { apiKey: key, model, signal: opts.signal })
      } catch (e) {
        if (e instanceof AiError) {
          // A refused or cut-off answer was still billed: count it, or retries spend past the cap.
          if (e.usage) record(e.usage)
          throw new AiError(e.code, scrub(e.message, key), e.usage)
        }
        throw new AiError('failed', scrub(e instanceof Error ? e.message : String(e), key))
      }
      record(r)
      return r
    }
  }
}
