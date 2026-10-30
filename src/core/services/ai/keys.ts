import { deletePassword, getPassword, hasPassword, setPassword } from '../../accounts/vault.js'
import type { AiProviderId } from './types.js'

/**
 * AI keys live in the vault like account passwords: encrypted with the OS
 * keychain (safeStorage), never in SQLite, never sent back over IPC.
 */
export const keyRef = (p: AiProviderId): string => `ai-${p}`

const KEY_RE = /^[\x21-\x7e]{8,512}$/

export function saveAiKey(p: AiProviderId, key: string): void {
  const k = key.trim()
  if (!KEY_RE.test(k)) throw new Error('That does not look like an API key')
  setPassword(keyRef(p), k)
}

export function aiKey(p: AiProviderId): string | null {
  return getPassword(keyRef(p))
}

export function hasAiKey(p: AiProviderId): boolean {
  return hasPassword(keyRef(p))
}

export function clearAiKey(p: AiProviderId): void {
  deletePassword(keyRef(p))
}
