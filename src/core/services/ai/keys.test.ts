import { beforeEach, describe, expect, it, vi } from 'vitest'

const secrets = new Map<string, string>()
vi.mock('../../accounts/vault.js', () => ({
  setPassword: (ref: string, v: string) => void secrets.set(ref, v),
  getPassword: (ref: string) => secrets.get(ref) ?? null,
  deletePassword: (ref: string) => void secrets.delete(ref),
  hasPassword: (ref: string) => secrets.has(ref)
}))

import { aiKey, clearAiKey, hasAiKey, keyRef, saveAiKey } from './keys.js'

beforeEach(() => secrets.clear())

describe('AI keys', () => {
  it('stores each provider key in the vault under its own ref, trimmed', () => {
    saveAiKey('anthropic', '  sk-ant-test-0123456789  ')
    expect(keyRef('anthropic')).toBe('ai-anthropic')
    expect(secrets.get('ai-anthropic')).toBe('sk-ant-test-0123456789')
    expect(aiKey('anthropic')).toBe('sk-ant-test-0123456789')
    expect(hasAiKey('openai')).toBe(false)
    clearAiKey('anthropic')
    expect(aiKey('anthropic')).toBeNull()
  })

  it('refuses something that is not a key', () => {
    expect(() => saveAiKey('openai', 'short')).toThrow(/API key/)
    expect(() => saveAiKey('openai', 'has a space in it')).toThrow(/API key/)
    expect(secrets.size).toBe(0)
  })
})
