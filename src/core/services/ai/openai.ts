import OpenAI from 'openai'
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import { AiError, type AiProvider } from './types.js'

/** Explicit, so an OPENAI_BASE_URL in the environment cannot redirect mail text. */
export const OPENAI_API = 'https://api.openai.com/v1'

/** Reasoning models take reasoning.effort; others reject it. */
const REASONING_MODEL = /^(gpt-5|gpt-6|o\d)/

function toAiError(e: unknown): AiError {
  if (e instanceof AiError) return e
  if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError)
    return new AiError('auth', 'OpenAI rejected the API key')
  if (e instanceof OpenAI.RateLimitError) return new AiError('rate', 'OpenAI is rate limiting this key; try again shortly')
  if (e instanceof OpenAI.APIConnectionError) return new AiError('network', 'Could not reach OpenAI')
  if (e instanceof OpenAI.APIError) return new AiError('failed', `OpenAI error ${e.status ?? ''}: ${e.message}`)
  return new AiError('failed', e instanceof Error ? e.message : String(e))
}

/** `baseURL` points tests and dev QA at the local mock; production leaves it unset. */
export function createOpenAiProvider(opts: { baseURL?: string } = {}): AiProvider {
  return {
    id: 'openai',
    async complete(req, { apiKey, model, signal }) {
      const client = new OpenAI({
        apiKey,
        // Nulls keep OPENAI_ADMIN_KEY / OPENAI_ORG_ID / OPENAI_PROJECT_ID out of the request.
        adminAPIKey: null,
        organization: null,
        project: null,
        baseURL: opts.baseURL ?? OPENAI_API,
        maxRetries: 2,
        timeout: 60_000,
        logLevel: 'off'
      })
      const params: ResponseCreateParamsNonStreaming = {
        model,
        instructions: req.system,
        input: req.prompt,
        max_output_tokens: req.maxTokens,
        // Mail text is not kept on OpenAI's side for later retrieval.
        store: false
      }
      if (REASONING_MODEL.test(model)) params.reasoning = { effort: 'low' }
      if (req.schema)
        params.text = { format: { type: 'json_schema', name: req.schema.name, schema: req.schema.schema, strict: true } }
      let r
      try {
        r = await client.responses.create(params, { signal })
      } catch (e) {
        throw toAiError(e)
      }
      // Billed even when rejected below, so the error carries it for the budget.
      const usage = { model: r.model, inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0 }
      // Partial text is not an answer: a cut-off summary or draft must not pass as complete.
      if (r.status === 'incomplete') throw new AiError('bad-output', 'The model ran out of room before answering', usage)
      const text = (r.output_text ?? '').trim()
      if (!text) throw new AiError('refused', 'The model declined this request', usage)
      return { text, ...usage }
    }
  }
}
