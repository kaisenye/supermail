import type { AccountConfig } from '../accounts/config.js'
import { resolveAuth } from '../accounts/auth.js'
import { saveLabelColors } from '../store/labels.js'

const LABELS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/labels'
/** Label colours change rarely; one label list per account per this long is plenty. */
const REFRESH_MS = 15 * 60_000
const lastRun = new Map<number, number>()

interface GmailLabel {
  name?: string
  type?: string
  color?: { backgroundColor?: string; textColor?: string }
}

const HEX = /^#[0-9a-f]{6}$/i

/** The user labels in a Gmail API label list that carry a colour. */
export function parseLabelColors(body: unknown): { name: string; bg: string; fg: string }[] {
  const labels = (body as { labels?: GmailLabel[] } | null)?.labels
  if (!Array.isArray(labels)) return []
  return labels.flatMap((l) => {
    const bg = l.color?.backgroundColor
    const fg = l.color?.textColor
    if (l.type !== 'user' || !l.name || !bg || !fg || !HEX.test(bg) || !HEX.test(fg)) return []
    return [{ name: l.name, bg: bg.toLowerCase(), fg: fg.toLowerCase() }]
  })
}

/**
 * Reads the account's Gmail label colours (IMAP does not carry them) and
 * stores them. Gmail OAuth accounts only: their `https://mail.google.com/`
 * scope covers the Gmail API. At most once per REFRESH_MS per account; a
 * failure (API off for the client, network) keeps what was stored and is
 * never a sync error. True when colours were saved.
 */
export async function refreshGmailLabelColors(
  accountId: number,
  config: AccountConfig,
  deps: { fetch?: typeof fetch; now?: number; token?: () => Promise<string> } = {}
): Promise<boolean> {
  if (config.provider !== 'gmail' || config.auth.kind !== 'oauth2') return false
  const now = deps.now ?? Date.now()
  if (now - (lastRun.get(accountId) ?? 0) < REFRESH_MS) return false
  lastRun.set(accountId, now)
  try {
    const auth = deps.token ? { accessToken: await deps.token() } : await resolveAuth(config)
    if (!('accessToken' in auth)) return false
    const res = await (deps.fetch ?? fetch)(LABELS_URL, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
      // Never let a slow API hold up the mail sync it runs inside.
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) {
      console.warn(`[sync] Gmail label colours: HTTP ${res.status}`)
      return false
    }
    saveLabelColors(accountId, parseLabelColors(await res.json()))
    return true
  } catch (e) {
    console.warn('[sync] Gmail label colours:', e instanceof Error ? e.message : e)
    return false
  }
}

/** Tests: forget when each account last ran. */
export function resetLabelColorTimer(): void {
  lastRun.clear()
}
