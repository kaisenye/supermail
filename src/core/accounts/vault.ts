import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/**
 * Password storage backed by the OS keychain via Electron safeStorage.
 * Ciphertext lands on disk under userData; the key lives in the keychain, so
 * copying the file to another machine yields nothing.
 *
 * Passwords never enter SQLite and never cross IPC — the renderer sends one
 * to be stored and never reads one back.
 */

let vaultDir: string | null = null

export function initVault(userDataDir: string): void {
  vaultDir = join(userDataDir, 'credentials')
  mkdirSync(vaultDir, { recursive: true })
}

function requireDir(): string {
  if (!vaultDir) throw new Error('vault not initialised')
  return vaultDir
}

/** auth_ref is an opaque filename, so an email change cannot orphan the secret. */
export function authRefFor(accountId: number): string {
  return `acct-${accountId}`
}

function pathFor(ref: string): string {
  // Refs are generated, never user input, but a traversal here would write
  // ciphertext anywhere on disk — cheap to make structurally impossible.
  if (!/^[A-Za-z0-9_-]+$/.test(ref)) throw new Error(`invalid auth_ref: ${ref}`)
  return join(requireDir(), `${ref}.bin`)
}

export function isVaultAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function setPassword(ref: string, password: string): void {
  if (!isVaultAvailable()) {
    throw new Error('OS keychain unavailable — cannot store credentials securely')
  }
  const target = pathFor(ref)
  const tmp = `${target}.tmp`
  mkdirSync(dirname(target), { recursive: true })
  // Write-then-rename: a crash mid-write must not truncate a working secret.
  writeFileSync(tmp, safeStorage.encryptString(password), { mode: 0o600 })
  renameSync(tmp, target)
}

export function getPassword(ref: string): string | null {
  let path: string
  try {
    path = pathFor(ref)
  } catch {
    return null
  }
  if (!existsSync(path)) return null
  try {
    return safeStorage.decryptString(readFileSync(path))
  } catch (err) {
    // Keychain entry revoked, or the file came from another machine.
    console.error(`[vault] cannot decrypt ${ref}:`, err)
    return null
  }
}

export function deletePassword(ref: string): void {
  try {
    rmSync(pathFor(ref), { force: true })
  } catch (err) {
    console.error(`[vault] delete failed for ${ref}:`, err)
  }
}

export function hasPassword(ref: string): boolean {
  try {
    return existsSync(pathFor(ref))
  } catch {
    return false
  }
}
