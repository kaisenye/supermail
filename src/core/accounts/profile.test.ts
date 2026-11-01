import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, initDb } from '../store/db.js'
import { setSetting } from '../store/repo.js'
import { displayNameFor } from './manage.js'
import { profileFromIdToken } from './oauth.js'
import { avatarFor, profileLoaded, saveProfile, sizedPhotoUrl } from './profile.js'

const idToken = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

/** A stand-in for the photo host: no test reaches the network. */
const photo = (status = 200, type = 'image/jpeg', bytes = 10) =>
  (async () => new Response(new Uint8Array(bytes), { status, headers: { 'content-type': type } })) as unknown as typeof fetch

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'profile-')), 't.db'))
})

describe('profile from the ID token', () => {
  it('reads the name and an https photo, and nothing from a token without them', () => {
    expect(profileFromIdToken(idToken({ name: ' Kaisen Ye ', picture: 'https://lh3.googleusercontent.com/a/x=s96-c' }))).toEqual({
      name: 'Kaisen Ye',
      picture: 'https://lh3.googleusercontent.com/a/x=s96-c'
    })
    expect(profileFromIdToken(idToken({ email: 'a@b.c', picture: 'http://x/y.png' }))).toEqual({ name: null, picture: null })
    expect(profileFromIdToken(undefined)).toEqual({ name: null, picture: null })
  })

  it('asks Google for a switcher-sized photo', () => {
    expect(sizedPhotoUrl('https://lh3.googleusercontent.com/a/abc=s96-c')).toBe('https://lh3.googleusercontent.com/a/abc=s96-c')
    expect(sizedPhotoUrl('https://lh3.googleusercontent.com/a/abc')).toBe('https://lh3.googleusercontent.com/a/abc=s96-c')
  })
})

describe('saveProfile', () => {
  it('keeps the photo as a data URL and names an inbox that had no name', async () => {
    await saveProfile(2, { name: 'Kaisen Ye', picture: 'https://lh3.googleusercontent.com/a/x' }, photo())
    expect(profileLoaded(2)).toBe(true)
    expect(avatarFor(2)).toMatch(/^data:image\/jpeg;base64,/)
    expect(displayNameFor(2)).toBe('Kaisen Ye')
  })

  it('never replaces a name the user set, and leaves the placeholder when the photo fails', async () => {
    setSetting('account.2.name', 'K. Ye')
    await saveProfile(2, { name: 'Kaisen Ye', picture: 'https://x/p' }, photo(404))
    expect(displayNameFor(2)).toBe('K. Ye')
    expect(avatarFor(2)).toBeNull()
    await saveProfile(2, { name: null, picture: 'https://x/p' }, photo(200, 'text/html'))
    expect(avatarFor(2)).toBeNull()
    expect(profileLoaded(2)).toBe(true)
  })
})
