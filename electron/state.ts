import type { AccountConfig } from '../src/core/accounts/index.js'

export type BootState =
  | { ok: true; accountId: number; email: string; config: AccountConfig }
  | { ok: false; error: string }

let state: BootState = { ok: false, error: 'not booted' }

export function setBootState(s: BootState): void {
  state = s
}

export function getBootState(): BootState {
  return state
}

/** Renderer-safe view: never exposes the password over IPC. */
export function getBootStatus(): { ok: boolean; email?: string; error?: string } {
  return state.ok ? { ok: true, email: state.email } : { ok: false, error: state.error }
}
