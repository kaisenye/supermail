import { describe, expect, it } from 'vitest'
import { aiConfigPatch, DEFAULT_MODELS, readAiSettings } from './settings.js'

const noKeys = { anthropic: false, openai: false }

describe('AI settings', () => {
  it('defaults to Anthropic, the default models, $1 a day and everything off', () => {
    expect(readAiSettings({})).toEqual({
      provider: 'anthropic',
      models: DEFAULT_MODELS,
      budgetUsd: 1,
      toggles: { write: false, replies: false, summary: false, classify: false, ask: false }
    })
    expect(DEFAULT_MODELS).toEqual({ anthropic: 'claude-sonnet-5-5', openai: 'gpt-6.1-sol' })
  })

  it('reads stored values and repairs bad ones', () => {
    const s = readAiSettings({
      ai_provider: 'openai',
      ai_model_openai: 'gpt-5.5',
      ai_model_anthropic: 'bad model id!',
      ai_daily_budget_usd: '250',
      ai_summary: '1'
    })
    expect(s.provider).toBe('openai')
    expect(s.models).toEqual({ anthropic: 'claude-sonnet-5-5', openai: 'gpt-5.5' })
    expect(s.budgetUsd).toBe(100)
    expect(s.toggles.summary).toBe(true)
    expect(readAiSettings({ ai_provider: 'mistral', ai_daily_budget_usd: '-3' })).toMatchObject({
      provider: 'anthropic',
      budgetUsd: 1
    })
    expect(readAiSettings({ ai_daily_budget_usd: '0' }).budgetUsd).toBe(0)
  })

  it('turns a config change into settings, refusing what main must not accept', () => {
    const ctx = { provider: 'anthropic' as const, hasKey: { anthropic: true, openai: false } }
    expect(aiConfigPatch({ provider: 'openai' }, ctx)).toEqual({
      ai_provider: 'openai',
      ai_write: '0',
      ai_replies: '0',
      ai_summary: '0',
      ai_classify: '0',
      ai_ask: '0'
    })
    expect(aiConfigPatch({ provider: 'anthropic' }, ctx)).toEqual({ ai_provider: 'anthropic' })
    expect(aiConfigPatch({ model: { provider: 'openai', model: ' gpt-5.5 ' } }, ctx)).toEqual({ ai_model_openai: 'gpt-5.5' })
    expect(aiConfigPatch({ model: { provider: 'anthropic', model: '' } }, ctx)).toEqual({ ai_model_anthropic: '' })
    expect(aiConfigPatch({ budgetUsd: 2.555 }, ctx)).toEqual({ ai_daily_budget_usd: '2.56' })
    expect(aiConfigPatch({ feature: { feature: 'summary', on: true } }, ctx)).toEqual({ ai_summary: '1' })
    expect(() => aiConfigPatch({ feature: { feature: 'summary', on: true } }, { ...ctx, hasKey: noKeys })).toThrow(/key/)
    expect(aiConfigPatch({ feature: { feature: 'summary', on: false } }, { ...ctx, hasKey: noKeys })).toEqual({ ai_summary: '0' })
    expect(() => aiConfigPatch({ budgetUsd: 101 }, ctx)).toThrow(/budget/)
    expect(() => aiConfigPatch({ model: { provider: 'anthropic', model: 'a b' } }, ctx)).toThrow(/model/)
    expect(() => aiConfigPatch({ provider: 'x' as never }, ctx)).toThrow(/provider/)
  })
})
