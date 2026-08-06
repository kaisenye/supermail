import type { AccountConfig } from '../src/core/accounts/index.js'

export interface LiveAccount {
  accountId: number
  email: string
  config: AccountConfig
}

export type BootState =
  | { ok: true; accountId: number; email: string; config: AccountConfig }
  | { ok: false; error: string }

/** Insertion order is the sidebar order. */
const accounts = new Map<number, LiveAccount>()
let activeId: number | null = null
let bootError = 'not booted'

export function addAccount(a: LiveAccount): void {
  accounts.set(a.accountId, a)
  if (activeId === null) activeId = a.accountId
}

export function removeAccount(accountId: number): void {
  accounts.delete(accountId)
  if (activeId === accountId) activeId = accounts.keys().next().value ?? null
}

export function setActiveAccount(accountId: number): boolean {
  if (!accounts.has(accountId)) return false
  activeId = accountId
  return true
}

export function getAccount(accountId: number): LiveAccount | null {
  return accounts.get(accountId) ?? null
}

export function listAccounts(): LiveAccount[] {
  return [...accounts.values()]
}

export function getActiveAccount(): LiveAccount | null {
  return activeId === null ? null : (accounts.get(activeId) ?? null)
}

export function setBootError(message: string): void {
  bootError = message
}

/**
 * The active account, in the shape the single-account call sites already use.
 * Multi-account paths should prefer getAccount(id) so a background job cannot
 * be retargeted by the user switching accounts mid-flight.
 */
export function getBootState(): BootState {
  const a = getActiveAccount()
  if (!a) return { ok: false, error: bootError }
  return { ok: true, accountId: a.accountId, email: a.email, config: a.config }
}

export function setBootState(s: BootState): void {
  if (s.ok) addAccount({ accountId: s.accountId, email: s.email, config: s.config })
  else bootError = s.error
}

export interface AccountSummary {
  accountId: number
  email: string
  name: string | null
  active: boolean
}

/** Renderer-safe view: never exposes the password over IPC. */
export function getBootStatus(): {
  ok: boolean
  email?: string
  error?: string
  accounts: AccountSummary[]
  activeAccountId: number | null
} {
  const list = listAccounts().map((a) => ({
    accountId: a.accountId,
    email: a.email,
    name: a.config.name,
    active: a.accountId === activeId
  }))
  const active = getActiveAccount()
  return active
    ? { ok: true, email: active.email, accounts: list, activeAccountId: activeId }
    : { ok: false, error: bootError, accounts: list, activeAccountId: null }
}
