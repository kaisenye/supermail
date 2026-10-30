import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'

/**
 * A local stand-in for the Anthropic Messages API and the OpenAI Responses
 * API. Tests start it on port 0; manual QA runs `pnpm ai:mock 4010` and points
 * the app at it (SUPERMAIL_ANTHROPIC_BASE_URL / SUPERMAIL_OPENAI_BASE_URL).
 * It never forwards anything anywhere.
 *
 * Put MOCK_401 anywhere in a prompt to get a rejected-key error, or
 * MOCK_TRUNCATE to get a reply cut off at the token limit (partial text,
 * stop_reason 'max_tokens' / status 'incomplete'), or MOCK_REFUSE to get a
 * refusal (Anthropic stop_reason 'refusal' / OpenAI empty output). Every 200
 * reply bills 120 input and 30 output tokens.
 */

export interface MockCall {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
}

export interface MockAiServer {
  url: string
  calls: MockCall[]
  close(): Promise<void>
}

export const MOCK_TEXT = 'This is a mock reply from the local AI test server.'
export const MOCK_CLASSIFICATION = { important: true, category: 'work', reason: 'Mock: asks you a direct question' }
export const MOCK_PARTIAL = 'This reply was cut off before'
export const MOCK_REPLIES = { options: ['Sounds good, thanks!', 'Not this week, sorry.', 'Can you tell me more?'] }

function pick(o: unknown, ...path: string[]): unknown {
  let cur = o
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

/** The canned answer: by the JSON schema the request asks for, else plain text. */
export function mockAnswer(body: Record<string, unknown>): string {
  const schema = JSON.stringify(
    pick(body, 'output_config', 'format', 'schema') ?? pick(body, 'text', 'format', 'schema') ?? null
  )
  if (schema.includes('"important"')) return JSON.stringify(MOCK_CLASSIFICATION)
  if (schema.includes('"options"')) return JSON.stringify(MOCK_REPLIES)
  return MOCK_TEXT
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function anthropic(res: ServerResponse, body: Record<string, unknown>, raw: string): void {
  if (raw.includes('MOCK_401'))
    return send(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
  const truncate = raw.includes('MOCK_TRUNCATE')
  const refuse = raw.includes('MOCK_REFUSE')
  send(res, 200, {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: refuse ? [] : [{ type: 'text', text: truncate ? MOCK_PARTIAL : mockAnswer(body) }],
    stop_reason: refuse ? 'refusal' : truncate ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  })
}

function openai(res: ServerResponse, body: Record<string, unknown>, raw: string): void {
  if (raw.includes('MOCK_401'))
    return send(res, 401, {
      error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' }
    })
  const truncate = raw.includes('MOCK_TRUNCATE')
  const text = raw.includes('MOCK_REFUSE') ? '' : truncate ? MOCK_PARTIAL : mockAnswer(body)
  const status = truncate ? 'incomplete' : 'completed'
  send(res, 200, {
    id: 'resp_mock',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    incomplete_details: truncate ? { reason: 'max_output_tokens' } : null,
    model: body.model,
    output: [
      {
        type: 'message',
        id: 'msg_mock',
        status,
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }]
      }
    ],
    output_text: text,
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 }
    }
  })
}

export function startMockAiServer(port = 0, log = false): Promise<MockAiServer> {
  const calls: MockCall[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        return send(res, 400, { error: { message: 'bad json' } })
      }
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      calls.push({ method: req.method ?? '', path, headers: req.headers, body })
      // Never log headers: they carry the (fake) key.
      if (log) console.log(`[ai-mock] ${req.method} ${path} model=${String(body.model)}`)
      if (req.method === 'POST' && path === '/v1/messages') return anthropic(res, body, raw)
      if (req.method === 'POST' && path === '/v1/responses') return openai(res, body, raw)
      send(res, 404, { error: { message: `mock has no ${path}` } })
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const actual = typeof addr === 'object' && addr ? addr.port : port
      resolve({
        url: `http://127.0.0.1:${actual}`,
        calls,
        close: () =>
          new Promise<void>((done) => {
            // The SDKs keep connections alive; without this, close() waits for them to time out.
            server.closeAllConnections()
            server.close(() => done())
          })
      })
    })
  })
}

// `pnpm ai:mock [port]`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 4010)
  void startMockAiServer(port, true).then((m) => {
    console.log(`Mock AI server on ${m.url}`)
    console.log(`  SUPERMAIL_ANTHROPIC_BASE_URL=${m.url} SUPERMAIL_OPENAI_BASE_URL=${m.url}/v1 pnpm dev`)
  })
}
