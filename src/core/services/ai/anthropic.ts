import Anthropic from '@anthropic-ai/sdk'
import type { BetaOutputConfig, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { AiError, type AiProvider } from './types.js'

/** Explicit, so an ANTHROPIC_BASE_URL in the environment cannot redirect mail text. */
export const ANTHROPIC_API = 'https://api.anthropic.com'

/**
 * Models that take server-side refusal fallback ("default" form). Haiku 5.5
 * has none: sending it there would keep a refusal a refusal.
 */
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1'])
/** Models that accept output_config.effort (Sonnet 4.5 / Haiku 4.5 reject it). */
const EFFORT_MODEL = /^claude-(fable|mythos|opus|sonnet|haiku)-5|^claude-opus-4-[5-8]|^claude-sonnet-4-6/

function toAiError(e: unknown): AiError {
  if (e instanceof AiError) return e
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
    return new AiError('auth', 'Anthropic rejected the API key')
  if (e instanceof Anthropic.RateLimitError) return new AiError('rate', 'Anthropic is rate limiting this key; try again shortly')
  if (e instanceof Anthropic.APIConnectionError) return new AiError('network', 'Could not reach Anthropic')
  if (e instanceof Anthropic.APIError) return new AiError('failed', `Anthropic error ${e.status ?? ''}: ${e.message}`)
  return new AiError('failed', e instanceof Error ? e.message : String(e))
}

/** `baseURL` points tests and dev QA at the local mock; production leaves it unset. */
export function createAnthropicProvider(opts: { baseURL?: string } = {}): AiProvider {
  return {
    id: 'anthropic',
    async complete(req, { apiKey, model, signal }) {
      const client = new Anthropic({
        apiKey,
        authToken: null,
        baseURL: opts.baseURL ?? ANTHROPIC_API,
        maxRetries: 2,
        timeout: 60_000,
        logLevel: 'off',
        openTelemetry: false
      })
      const params: MessageCreateParamsNonStreaming = {
        model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }]
      }
      const config: BetaOutputConfig = {}
      if (EFFORT_MODEL.test(model)) config.effort = 'low'
      if (req.schema) config.format = { type: 'json_schema', schema: req.schema.schema }
      if (config.effort || config.format) params.output_config = config
      if (FALLBACK_MODELS.has(model)) {
        params.betas = ['server-side-fallback-2026-07-01']
        params.fallbacks = 'default'
      }
      let msg
      try {
        msg = await client.beta.messages.create(params, { signal })
      } catch (e) {
        throw toAiError(e)
      }
      // Billed even when rejected below, so the error carries it for the budget.
      const usage = { model: msg.model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens }
      if (msg.stop_reason === 'refusal') throw new AiError('refused', 'The model declined this request', usage)
      // Partial text is not an answer: a cut-off summary or draft must not pass as complete.
      if (msg.stop_reason === 'max_tokens')
        throw new AiError('bad-output', 'The model ran out of room before answering', usage)
      const text = msg.content
        .flatMap((b) => (b.type === 'text' ? [b.text] : []))
        .join('')
        .trim()
      if (!text) throw new AiError('bad-output', 'The model returned no text', usage)
      return { text, ...usage }
    }
  }
}
