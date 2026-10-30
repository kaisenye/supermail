import { describe, expect, it } from 'vitest'
import { parseJsonReply } from './json.js'
import { costMicros, priceFor } from './pricing.js'
import { BACKGROUND_SHARE, createAi, localDay, scrub, type UsageRecord } from './service.js'
import { AiError, type AiProvider, type AiProviderId, type AiRequest } from './types.js'

const NOW = new Date(2026, 9, 30, 12).getTime()
const KEY = 'sk-ant-test-0123456789'

function setup(opts: {
  settings?: Record<string, string>
  keys?: Partial<Record<AiProviderId, string>>
  spent?: number
  reply?: (req: AiRequest, model: string, provider: AiProviderId) => string
  fail?: Error
}) {
  const records: UsageRecord[] = []
  const calls: { provider: AiProviderId; model: string; apiKey: string; req: AiRequest }[] = []
  const provider = (id: AiProviderId): AiProvider => ({
    id,
    async complete(req, o) {
      calls.push({ provider: id, model: o.model, apiKey: o.apiKey, req })
      if (opts.fail) throw opts.fail
      return { text: opts.reply?.(req, o.model, id) ?? 'ok', model: o.model, inputTokens: 1000, outputTokens: 100 }
    }
  })
  const ai = createAi({
    settings: () => opts.settings ?? { ai_summary: '1' },
    key: (p) => (opts.keys ?? { anthropic: KEY })[p] ?? null,
    providers: { anthropic: provider('anthropic'), openai: provider('openai') },
    usage: {
      spentMicros: (day) => (day === localDay(NOW) ? (opts.spent ?? 0) : 0),
      record: (u) => void records.push(u)
    },
    now: () => NOW
  })
  return { ai, records, calls }
}

const req: AiRequest = { system: 's', prompt: 'p', maxTokens: 100 }

describe('the AI service', () => {
  it('refuses a feature that is off, then one whose provider has no key', async () => {
    await expect(setup({}).ai.run('write', req)).rejects.toMatchObject({ code: 'disabled', message: 'Write with AI is off in Settings → AI' })
    await expect(setup({ keys: {} }).ai.run('summary', req)).rejects.toMatchObject({ code: 'no-key', message: 'Add your Anthropic key in Settings → AI' })
  })

  it('calls the chosen provider with its model and records usage at its price', async () => {
    const { ai, records, calls } = setup({
      settings: { ai_provider: 'openai', ai_model_openai: 'gpt-5.5', ai_summary: '1' },
      keys: { openai: 'sk-openai-test-0123' }
    })
    const r = await ai.run('summary', req)
    expect(r.text).toBe('ok')
    expect(calls).toEqual([{ provider: 'openai', model: 'gpt-5.5', apiKey: 'sk-openai-test-0123', req }])
    expect(records).toEqual([
      {
        day: localDay(NOW),
        provider: 'openai',
        model: 'gpt-5.5',
        feature: 'summary',
        inputTokens: 1000,
        outputTokens: 100,
        costMicros: 1000 * 5 + 100 * 30
      }
    ])
  })

  it('stops at the daily budget; background work stops at 80% of it', async () => {
    // $1 cap = 1_000_000 micros.
    await expect(setup({ spent: 1_000_000 }).ai.run('summary', req)).rejects.toMatchObject({ code: 'budget' })
    await expect(setup({ spent: 999_999 }).ai.run('summary', req)).resolves.toMatchObject({ text: 'ok' })
    expect(BACKGROUND_SHARE).toBe(0.8)
    await expect(setup({ spent: 800_000 }).ai.run('summary', req, { background: true })).rejects.toMatchObject({
      code: 'budget'
    })
    await expect(setup({ settings: { ai_summary: '1', ai_daily_budget_usd: '0' } }).ai.run('summary', req)).rejects.toMatchObject({
      code: 'budget'
    })
  })

  it('never lets the key out in an error', async () => {
    const { ai } = setup({ fail: new Error(`401 bad key ${KEY}`) })
    const e = await ai.run('summary', req).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AiError)
    expect((e as AiError).message).not.toContain(KEY)
    expect((e as AiError).message).toContain('[key]')
    const typed = await setup({ fail: new AiError('auth', `rejected ${KEY}`) }).ai.run('summary', req).catch((x: unknown) => x)
    expect(typed).toMatchObject({ code: 'auth', message: 'rejected [key]' })
    expect(scrub('short', 'abc')).toBe('short')
  })

  it('records the spend of a billed answer the provider rejected, then rethrows it', async () => {
    const usage = { model: 'claude-sonnet-5-5', inputTokens: 1_000, outputTokens: 100 }
    let spent = 0
    const records: UsageRecord[] = []
    const ai = createAi({
      settings: () => ({ ai_summary: '1' }),
      key: () => KEY,
      providers: {
        anthropic: {
          id: 'anthropic',
          complete: async () => {
            throw new AiError('refused', `declined ${KEY}`, usage)
          }
        },
        openai: { id: 'openai', complete: async () => ({ text: '', model: '', inputTokens: 0, outputTokens: 0 }) }
      },
      usage: {
        spentMicros: () => spent,
        record: (u) => {
          records.push(u)
          spent += u.costMicros
        }
      },
      now: () => NOW
    })
    const e = await ai.run('summary', req).catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'refused', message: 'declined [key]' })
    const cost = costMicros('anthropic', 'claude-sonnet-5-5', 1_000, 100)
    expect(cost).toBeGreaterThan(0)
    expect(records).toEqual([
      { day: localDay(NOW), provider: 'anthropic', model: 'claude-sonnet-5-5', feature: 'summary', inputTokens: 1_000, outputTokens: 100, costMicros: cost }
    ])
    expect(spent).toBe(cost)
    expect(ai.status().spentTodayUsd).toBe(cost / 1e6)
  })

  it('records nothing for a failure the provider did not bill', async () => {
    const { ai, records } = setup({ fail: new AiError('network', 'Could not reach Anthropic') })
    await expect(ai.run('summary', req)).rejects.toMatchObject({ code: 'network' })
    expect(records).toEqual([])
  })

  it('reports a feature as on only when its provider has a key', () => {
    const on = setup({ settings: { ai_summary: '1', ai_ask: '1' } }).ai.status()
    expect(on.features).toMatchObject({ summary: true, ask: true, write: false })
    expect(on.hasKey).toEqual({ anthropic: true, openai: false })
    const off = setup({ settings: { ai_summary: '1' }, keys: {} }).ai.status()
    expect(off.toggles.summary).toBe(true)
    expect(off.features.summary).toBe(false)
    expect(setup({ spent: 250_000 }).ai.status().spentTodayUsd).toBe(0.25)
  })
})

describe('pricing and JSON', () => {
  it('prices dated snapshots as their family and unknown models at the dearest price', () => {
    expect(priceFor('openai', 'gpt-6.1-sol-2026-09-30')).toEqual([2, 10])
    expect(priceFor('anthropic', 'claude-opus-5-5')).toEqual([4, 20])
    expect(priceFor('anthropic', 'claude-next')).toEqual([10, 50])
    expect(costMicros('anthropic', 'claude-sonnet-5-5', 1_000_000, 0)).toBe(2_000_000)
  })

  it('reads JSON from a fenced reply and rejects prose', () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(() => parseJsonReply('sorry')).toThrow(AiError)
  })
})
