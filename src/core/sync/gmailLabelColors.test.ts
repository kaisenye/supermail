import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AccountConfig } from '../accounts/config.js'
import { closeDb, getDb, initDb } from '../store/db.js'
import { labelColors } from '../store/labels.js'
import { parseLabelColors, refreshGmailLabelColors, resetLabelColorTimer } from './gmailLabelColors.js'

const gmail = {
  email: 'me@gmail.com',
  provider: 'gmail',
  auth: { kind: 'oauth2', provider: 'google', ref: 'r1' }
} as unknown as AccountConfig

const body = {
  labels: [
    { name: 'INBOX', type: 'system' },
    { name: 'USCIS', type: 'user', color: { backgroundColor: '#16A766', textColor: '#ffffff' } },
    { name: 'House', type: 'user' },
    { name: 'Bad', type: 'user', color: { backgroundColor: 'red', textColor: '#fff' } }
  ]
}

/** A stand-in for the Gmail API: no test reaches the network. */
function fakeFetch(status = 200) {
  const calls: { url: string; auth: string }[] = []
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: (init?.headers as Record<string, string>).Authorization })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { f, calls }
}

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'colors-')), 't.db'))
  getDb().prepare("INSERT INTO accounts (id,email,provider) VALUES (1,'me@gmail.com','gmail')").run()
  resetLabelColorTimer()
})

describe('Gmail label colours', () => {
  it('keeps user labels with a valid colour pair, lower-cased', () => {
    expect(parseLabelColors(body)).toEqual([{ name: 'USCIS', bg: '#16a766', fg: '#ffffff' }])
    expect(parseLabelColors(null)).toEqual([])
  })

  it('reads the label list with the OAuth token and stores the colours, at most every 15 minutes', async () => {
    const { f, calls } = fakeFetch()
    const deps = { fetch: f, token: async () => 'tok', now: 1_000_000 }
    expect(await refreshGmailLabelColors(1, gmail, deps)).toBe(true)
    expect(calls[0]).toEqual({ url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels', auth: 'Bearer tok' })
    expect(labelColors(1)).toEqual({ USCIS: { bg: '#16a766', fg: '#ffffff' } })
    expect(await refreshGmailLabelColors(1, gmail, { ...deps, now: 1_000_000 + 60_000 })).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('keeps what it had when the API refuses, and skips non-Gmail accounts', async () => {
    await refreshGmailLabelColors(1, gmail, { fetch: fakeFetch().f, token: async () => 't', now: 1_000_000 })
    resetLabelColorTimer()
    expect(await refreshGmailLabelColors(1, gmail, { fetch: fakeFetch(403).f, token: async () => 't', now: 2_000_000 })).toBe(false)
    expect(Object.keys(labelColors(1))).toEqual(['USCIS'])
    const { f, calls } = fakeFetch()
    const exmail = { ...gmail, provider: 'imap', auth: { kind: 'password', pass: 'x' } } as unknown as AccountConfig
    expect(await refreshGmailLabelColors(1, exmail, { fetch: f })).toBe(false)
    expect(calls).toEqual([])
  })
})
