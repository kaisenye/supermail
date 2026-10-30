import type { Ai, AiStatus, RunOptions } from './service.js'
import { DEFAULT_MODELS } from './settings.js'
import { AI_FEATURES, AiError, type AiFeature, type AiRequest } from './types.js'

export interface FakeCall {
  feature: AiFeature
  req: AiRequest
  background: boolean
}

/**
 * An `Ai` for feature tests: no network, no budget. `reply` returns the text
 * (or throws). Every feature is on unless `features` says otherwise.
 */
export function fakeAi(
  reply: (feature: AiFeature, req: AiRequest) => string,
  opts: { features?: Partial<Record<AiFeature, boolean>>; hasKey?: boolean } = {}
): Ai & { calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const features = Object.fromEntries(AI_FEATURES.map((f) => [f, opts.features?.[f] ?? true])) as Record<
    AiFeature,
    boolean
  >
  const hasKey = opts.hasKey ?? true
  const status = (): AiStatus => ({
    provider: 'anthropic',
    models: DEFAULT_MODELS,
    defaultModels: DEFAULT_MODELS,
    hasKey: { anthropic: hasKey, openai: false },
    budgetUsd: 1,
    spentTodayUsd: 0,
    toggles: features,
    features: Object.fromEntries(AI_FEATURES.map((f) => [f, features[f] && hasKey])) as Record<AiFeature, boolean>
  })
  return {
    calls,
    status,
    async run(feature: AiFeature, req: AiRequest, o: RunOptions = {}) {
      if (!status().features[feature]) throw new AiError('disabled', `${feature} is off`)
      calls.push({ feature, req, background: !!o.background })
      return { text: reply(feature, req), model: 'fake-model', inputTokens: 10, outputTokens: 5 }
    }
  }
}
