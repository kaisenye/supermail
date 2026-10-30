import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAnthropicProvider } from './anthropic.js'
import { createOpenAiProvider } from './openai.js'
import { MOCK_CLASSIFICATION, MOCK_PARTIAL, MOCK_TEXT, startMockAiServer, type MockAiServer } from './mockServer.js'
import { AiError } from './types.js'

const KEY = 'sk-test-0123456789abcdef'
const SCHEMA = {
  name: 'classification',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['important'],
    properties: { important: { type: 'boolean' } }
  }
}

let mock: MockAiServer
beforeAll(async () => {
  mock = await startMockAiServer(0)
})
afterAll(() => mock.close())
beforeEach(() => {
  mock.calls.length = 0
})

describe('Anthropic provider (against the local mock)', () => {
  const p = () => createAnthropicProvider({ baseURL: mock.url })

  it('sends the key, model, effort and refusal fallback, and reads text and usage', async () => {
    const r = await p().complete(
      { system: 'sys', prompt: 'hello', maxTokens: 500 },
      { apiKey: KEY, model: 'claude-sonnet-5-5' }
    )
    expect(r).toEqual({ text: MOCK_TEXT, model: 'claude-sonnet-5-5', inputTokens: 120, outputTokens: 30 })
    const call = mock.calls[0]
    expect(call.path).toBe('/v1/messages')
    // SDK 1.x sends an API key as a bearer token, not x-api-key.
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(call.headers['x-api-key']).toBeUndefined()
    expect(String(call.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01')
    expect(call.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 500,
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      output_config: { effort: 'low' },
      fallbacks: 'default'
    })
    expect(call.body).not.toHaveProperty('temperature')
  })

  it('asks for JSON by schema, and sends no fallback for a model without one', async () => {
    const r = await p().complete(
      { system: 's', prompt: 'p', maxTokens: 300, schema: SCHEMA },
      { apiKey: KEY, model: 'claude-haiku-5-5' }
    )
    expect(JSON.parse(r.text)).toEqual(MOCK_CLASSIFICATION)
    expect(mock.calls[0].body).toMatchObject({
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA.schema } }
    })
    expect(mock.calls[0].body).not.toHaveProperty('fallbacks')
    expect(String(mock.calls[0].headers['anthropic-beta'] ?? '')).not.toContain('server-side-fallback')
  })

  it('turns a rejected key into an auth error that does not echo the key', async () => {
    const e = await p()
      .complete({ system: 's', prompt: 'MOCK_401', maxTokens: 10 }, { apiKey: KEY, model: 'claude-sonnet-5-5' })
      .catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AiError)
    expect(e).toMatchObject({ code: 'auth' })
    expect((e as Error).message).not.toContain(KEY)
  })

  it('treats a reply cut off at max_tokens as bad output, not a partial answer', async () => {
    const e = await p()
      .complete({ system: 's', prompt: 'MOCK_TRUNCATE', maxTokens: 10 }, { apiKey: KEY, model: 'claude-sonnet-5-5' })
      .catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AiError)
    expect(e).toMatchObject({ code: 'bad-output' })
    expect((e as Error).message).not.toContain(MOCK_PARTIAL)
  })

  it('attaches the billed usage to a refusal and a cut-off reply, so the budget counts them', async () => {
    for (const [prompt, code] of [
      ['MOCK_REFUSE', 'refused'],
      ['MOCK_TRUNCATE', 'bad-output']
    ] as const) {
      const e = await p()
        .complete({ system: 's', prompt, maxTokens: 10 }, { apiKey: KEY, model: 'claude-sonnet-5-5' })
        .catch((x: unknown) => x)
      expect(e).toMatchObject({ code, usage: { model: 'claude-sonnet-5-5', inputTokens: 120, outputTokens: 30 } })
    }
  })

  it('carries no usage on an error the provider did not bill', async () => {
    const e = await p()
      .complete({ system: 's', prompt: 'MOCK_401', maxTokens: 10 }, { apiKey: KEY, model: 'claude-sonnet-5-5' })
      .catch((x: unknown) => x)
    expect((e as AiError).usage).toBeUndefined()
  })
})

describe('OpenAI provider (against the local mock)', () => {
  const p = () => createOpenAiProvider({ baseURL: `${mock.url}/v1` })

  it('uses the Responses API with store off and low reasoning effort', async () => {
    const r = await p().complete({ system: 'sys', prompt: 'hello', maxTokens: 500 }, { apiKey: KEY, model: 'gpt-6.1-sol' })
    expect(r).toEqual({ text: MOCK_TEXT, model: 'gpt-6.1-sol', inputTokens: 120, outputTokens: 30 })
    const call = mock.calls[0]
    expect(call.path).toBe('/v1/responses')
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(call.body).toMatchObject({
      model: 'gpt-6.1-sol',
      instructions: 'sys',
      input: 'hello',
      max_output_tokens: 500,
      store: false,
      reasoning: { effort: 'low' }
    })
  })

  it('asks for strict JSON by schema, and sends no reasoning effort to a non-reasoning model', async () => {
    const r = await p().complete(
      { system: 's', prompt: 'p', maxTokens: 300, schema: SCHEMA },
      { apiKey: KEY, model: 'gpt-4.1' }
    )
    expect(JSON.parse(r.text)).toEqual(MOCK_CLASSIFICATION)
    expect(mock.calls[0].body).toMatchObject({
      text: { format: { type: 'json_schema', name: 'classification', schema: SCHEMA.schema, strict: true } }
    })
    expect(mock.calls[0].body).not.toHaveProperty('reasoning')
  })

  it('turns a rejected key into an auth error', async () => {
    const e = await p()
      .complete({ system: 's', prompt: 'MOCK_401', maxTokens: 10 }, { apiKey: KEY, model: 'gpt-6.1-sol' })
      .catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'auth' })
    expect((e as Error).message).not.toContain(KEY)
  })

  it('treats an incomplete response with partial text as bad output', async () => {
    const e = await p()
      .complete({ system: 's', prompt: 'MOCK_TRUNCATE', maxTokens: 10 }, { apiKey: KEY, model: 'gpt-6.1-sol' })
      .catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AiError)
    expect(e).toMatchObject({ code: 'bad-output' })
    expect((e as Error).message).not.toContain(MOCK_PARTIAL)
  })

  it('attaches the billed usage to an incomplete or empty response, so the budget counts it', async () => {
    for (const [prompt, code] of [
      ['MOCK_TRUNCATE', 'bad-output'],
      ['MOCK_REFUSE', 'refused']
    ] as const) {
      const e = await p()
        .complete({ system: 's', prompt, maxTokens: 10 }, { apiKey: KEY, model: 'gpt-6.1-sol' })
        .catch((x: unknown) => x)
      expect(e).toMatchObject({ code, usage: { model: 'gpt-6.1-sol', inputTokens: 120, outputTokens: 30 } })
    }
  })
})
