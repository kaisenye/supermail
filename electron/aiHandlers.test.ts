import { describe, expect, it } from 'vitest'
import { fakeAi } from '../src/core/services/ai/fake.js'
import { createAi } from '../src/core/services/ai/service.js'
import { AI_FEATURES, type AiProvider, type AiProviderId } from '../src/core/services/ai/types.js'
import { aiWrite, createAiHandlers, type AiWriteDeps } from './aiHandlers.js'

const KEY = 'sk-test-0123456789'
const allOn = Object.fromEntries(AI_FEATURES.map((f) => [`ai_${f}`, '1']))

/** The real service over in-memory settings and vault, wired the way main wires it. */
function setup(settings: Record<string, string>, keys: Partial<Record<AiProviderId, string>>) {
  const vault = new Map(Object.entries(keys)) as Map<AiProviderId, string>
  const provider = (id: AiProviderId): AiProvider => ({
    id,
    complete: async () => ({ text: 'ok', model: 'm', inputTokens: 0, outputTokens: 0 })
  })
  const ai = createAi({
    settings: () => settings,
    key: (p) => vault.get(p) ?? null,
    providers: { anthropic: provider('anthropic'), openai: provider('openai') },
    usage: { spentMicros: () => 0, record: () => {} }
  })
  const cleared = { verdicts: 0 }
  const h = createAiHandlers({
    status: () => ai.status(),
    settings: () => settings,
    setSetting: (k, v) => void (settings[k] = v),
    saveKey: (p, k) => void vault.set(p, k),
    clearKey: (p) => void vault.delete(p),
    clearClassifications: () => void cleared.verdicts++
  })
  return { ai, h, settings, cleared }
}

const anyToggle = (s: ReturnType<ReturnType<typeof createAi>['status']>) => AI_FEATURES.some((f) => s.toggles[f])
const anyFeature = (s: ReturnType<ReturnType<typeof createAi>['status']>) => AI_FEATURES.some((f) => s.features[f])

describe('ai IPC handlers', () => {
  it('a switch to a provider with no key, then adding its key, leaves every feature off', () => {
    const { ai, h } = setup({ ai_provider: 'anthropic', ...allOn }, { anthropic: KEY })
    expect(anyFeature(ai.status())).toBe(true)
    expect(h.setConfig({ provider: 'openai' })).toMatchObject({ ok: true })
    expect(anyToggle(ai.status())).toBe(false)
    const r = h.setKey('openai', KEY)
    expect(r.ok).toBe(true)
    expect(ai.status().hasKey.openai).toBe(true)
    expect(anyToggle(ai.status())).toBe(false)
    expect(anyFeature(ai.status())).toBe(false)
  })

  it('a key cleared on the inactive provider cannot revive its features after a switch back', () => {
    const { ai, h } = setup({ ai_provider: 'anthropic', ...allOn }, { anthropic: KEY, openai: KEY })
    h.setConfig({ provider: 'openai' })
    h.clearKey('anthropic')
    h.setConfig({ provider: 'anthropic' })
    h.setKey('anthropic', KEY)
    expect(anyFeature(ai.status())).toBe(false)
  })

  it('re-selecting the current provider keeps the toggles', () => {
    const { ai, h } = setup({ ai_provider: 'anthropic', ...allOn }, { anthropic: KEY })
    h.setConfig({ provider: 'anthropic' })
    expect(AI_FEATURES.every((f) => ai.status().features[f])).toBe(true)
  })

  it('clearing the active provider key zeroes the toggles', () => {
    const { ai, h, settings } = setup({ ai_provider: 'openai', ...allOn }, { openai: KEY })
    expect(h.clearKey('openai')).toMatchObject({ ok: true })
    expect(AI_FEATURES.every((f) => settings[`ai_${f}`] === '0')).toBe(true)
    h.setKey('openai', KEY)
    expect(anyFeature(ai.status())).toBe(false)
  })

  it('drops stored verdicts whenever the classifier ends up off, and only then', () => {
    const { h, cleared } = setup({ ai_provider: 'anthropic', ...allOn }, { anthropic: KEY, openai: KEY })
    h.setConfig({ budgetUsd: 2 })
    h.setConfig({ feature: { feature: 'summary', on: false } })
    expect(cleared.verdicts).toBe(0)
    h.setConfig({ feature: { feature: 'classify', on: false } })
    expect(cleared.verdicts).toBe(1)
    h.setConfig({ feature: { feature: 'classify', on: true } })
    h.setConfig({ provider: 'openai' })
    expect(cleared.verdicts).toBe(2)
    h.setConfig({ feature: { feature: 'classify', on: true } })
    h.clearKey('openai')
    expect(cleared.verdicts).toBe(3)
  })

  it('rejects an unknown provider without touching the vault', () => {
    const { h } = setup({}, {})
    expect(h.setKey('mistral' as never, KEY)).toMatchObject({ ok: false, error: /provider/ })
    expect(h.clearKey('mistral' as never)).toMatchObject({ ok: false, error: /provider/ })
  })
})

describe('ai:write handler', () => {
  const src = { id: 7, account_id: 2, thread_id: 't1' }
  const msg = (date: number, text: string) => ({
    from_addr: 'ann@x.test',
    from_name: 'Ann',
    subject: 's',
    date,
    body_text: text,
    body_html: null,
    snippet: null
  })
  const deps = (ai: AiWriteDeps['ai']): AiWriteDeps => ({
    ai,
    message: (id) => (id === 7 ? src : undefined),
    thread: (accountId, threadId) => (accountId === 2 && threadId === 't1' ? [msg(2000, 'newer'), msg(1000, 'older')] : []),
    displayName: (accountId) => (accountId === 2 ? 'Kai' : null)
  })

  it('drafts with the replied-to thread and the owning account name', async () => {
    const ai = fakeAi(() => 'Yes, Friday works.')
    const r = await aiWrite(deps(ai), { action: 'draft', text: '', instruction: 'say yes', sourceMessageId: 7 })
    expect(r).toEqual({ ok: true, text: 'Yes, Friday works.' })
    expect(ai.calls[0].req.prompt).toContain('older')
    expect(ai.calls[0].req.prompt).toContain('newer')
    expect(ai.calls[0].req.system).toContain('(Kai)')
  })

  it('passes the selection scope through to the prompt', async () => {
    const ai = fakeAi(() => 'hi')
    await aiWrite(deps(ai), { action: 'draft', text: 'see you', instruction: 'say hi', scope: 'selection' })
    expect(ai.calls[0].req.prompt).toContain('Replace it with: say hi')
  })

  it('sends no thread for a rewrite', async () => {
    const ai = fakeAi(() => 'Short.')
    await aiWrite(deps(ai), { action: 'shorten', text: 'A long one', sourceMessageId: 7 })
    expect(ai.calls[0].req.prompt).not.toContain('<message')
  })

  it('rejects an unknown action and reports a switched-off feature', async () => {
    expect(await aiWrite(deps(fakeAi(() => '')), { action: 'poem' as never, text: 'x' })).toMatchObject({
      ok: false,
      code: 'invalid'
    })
    const off = fakeAi(() => '', { features: { write: false } })
    expect(await aiWrite(deps(off), { action: 'fix', text: 'teh' })).toMatchObject({ ok: false, code: 'disabled' })
  })
})
