import { getSettings, setSetting } from '../store/repo.js'
import { displayNameFor, rememberDisplayName } from './manage.js'

/**
 * An inbox's face in the switcher: the name and photo its provider gave at
 * sign-in (Google / Microsoft, `profile` scope). The photo is stored as a
 * data URL so the switcher never loads it from the network.
 */
const avatarKey = (accountId: number): string => `account.${accountId}.avatar`
/** Set once a sign-in asked for `profile`; until then an OAuth inbox is offered a reconnect. */
const profileKey = (accountId: number): string => `account.${accountId}.profile`

/** A photo larger than this is not kept (Google's are a few KB at this size). */
const MAX_AVATAR_BYTES = 256 * 1024
const AVATAR_PX = 96

export function avatarFor(accountId: number): string | null {
  return getSettings()[avatarKey(accountId)] || null
}

export function profileLoaded(accountId: number): boolean {
  return getSettings()[profileKey(accountId)] === '1'
}

/** Google photo URLs end in a size (`=s96-c`); ask for one fit for the switcher. */
export function sizedPhotoUrl(url: string): string {
  return /googleusercontent\.com\//.test(url) ? url.replace(/=s\d+(-c)?$/, '') + `=s${AVATAR_PX}-c` : url
}

/**
 * Records what a profile-scoped sign-in returned: the name becomes the From:
 * name only when the user has none, and the photo is fetched and kept. A
 * failed photo fetch leaves the grey placeholder; it never fails the sign-in.
 */
export async function saveProfile(
  accountId: number,
  p: { name: string | null; picture: string | null },
  fetchFn: typeof fetch = fetch
): Promise<void> {
  setSetting(profileKey(accountId), '1')
  if (p.name && !displayNameFor(accountId)) rememberDisplayName(accountId, p.name)
  if (!p.picture) return setSetting(avatarKey(accountId), '')
  try {
    const res = await fetchFn(sizedPhotoUrl(p.picture), { signal: AbortSignal.timeout(8000) })
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok || !/^image\/(png|jpe?g|gif|webp)/.test(type)) return
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > MAX_AVATAR_BYTES) return
    setSetting(avatarKey(accountId), `data:${type.split(';')[0]};base64,${bytes.toString('base64')}`)
  } catch (e) {
    console.warn('[accounts] profile photo:', e instanceof Error ? e.message : e)
  }
}
