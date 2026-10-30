/** Providers a user can bring a key for. */
export type AiProviderId = 'anthropic' | 'openai'
export const AI_PROVIDERS: AiProviderId[] = ['anthropic', 'openai']

/** Each feature has its own switch in Settings → AI. */
export type AiFeature = 'write' | 'replies' | 'summary' | 'classify' | 'ask'
export const AI_FEATURES: AiFeature[] = ['write', 'replies', 'summary', 'classify', 'ask']

export interface AiRequest {
  system: string
  prompt: string
  /** Includes any thinking the model does; keep it roomy. */
  maxTokens: number
  /**
   * Structured output: the reply must be JSON matching this schema. Write it
   * strict: every property required, `additionalProperties: false`.
   */
  schema?: { name: string; schema: Record<string, unknown> }
}

export interface AiResult {
  text: string
  /** The model that answered, as the provider reports it (prices the call). */
  model: string
  inputTokens: number
  outputTokens: number
}

export interface AiCallOptions {
  apiKey: string
  model: string
  signal?: AbortSignal
}

/** One provider SDK behind the smallest surface the features need. */
export interface AiProvider {
  id: AiProviderId
  complete(req: AiRequest, opts: AiCallOptions): Promise<AiResult>
}

export type AiErrorCode =
  | 'disabled'
  | 'no-key'
  | 'budget'
  | 'auth'
  | 'rate'
  | 'refused'
  | 'network'
  | 'bad-output'
  | 'invalid'
  | 'failed'

/** Tokens a provider billed for a response it then rejected (refusal, cut off, empty). */
export interface AiUsage {
  model: string
  inputTokens: number
  outputTokens: number
}

/** Every AI failure the UI sees. The message is safe to show and never holds the key. */
export class AiError extends Error {
  readonly code: AiErrorCode
  /** Set when the provider answered (and billed) before the answer was rejected, so the budget still counts it. */
  readonly usage?: AiUsage
  constructor(code: AiErrorCode, message: string, usage?: AiUsage) {
    super(message)
    this.name = 'AiError'
    this.code = code
    if (usage) this.usage = usage
  }
}
