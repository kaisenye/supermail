import { describe, expect, it, vi } from 'vitest'
import {
  isPublicPostHost,
  oneClickPost,
  parseListUnsubscribe,
  parseMailto,
  planUnsubscribe,
  runUnsubscribe
} from './unsubscribe.js'

describe('List-Unsubscribe parsing', () => {
  it('splits web and mailto targets, in header order', () => {
    expect(
      parseListUnsubscribe('<mailto:u@l.test?subject=stop>, <https://l.test/u?id=1>, <http://l.test/old>')
    ).toEqual({ web: ['https://l.test/u?id=1', 'http://l.test/old'], mailto: ['mailto:u@l.test?subject=stop'] })
    expect(parseListUnsubscribe(null)).toEqual({ web: [], mailto: [] })
    expect(parseListUnsubscribe('no brackets here')).toEqual({ web: [], mailto: [] })
  })

  it('reads a mailto address, subject and body', () => {
    expect(parseMailto('mailto:u@l.test?subject=stop&body=please')).toEqual({ to: 'u@l.test', subject: 'stop', body: 'please' })
    expect(parseMailto('mailto:u@l.test')).toEqual({ to: 'u@l.test', subject: 'unsubscribe', body: 'unsubscribe' })
    expect(parseMailto('mailto:not-an-address')).toBeNull()
  })
})

describe('planUnsubscribe', () => {
  const header = '<mailto:u@l.test>, <https://l.test/u>'
  it('prefers an RFC 8058 one-click POST', () => {
    expect(planUnsubscribe(header, true)).toEqual({ method: 'post', url: 'https://l.test/u', host: 'l.test' })
  })
  it('falls back to mail, then to the browser', () => {
    expect(planUnsubscribe(header, false)).toEqual({ method: 'mailto', to: 'u@l.test', subject: 'unsubscribe', body: 'unsubscribe' })
    expect(planUnsubscribe('<https://l.test/u>', false)).toEqual({ method: 'browser', url: 'https://l.test/u', host: 'l.test' })
  })
  it('never POSTs over plain http', () => {
    expect(planUnsubscribe('<http://l.test/u>', true)).toEqual({ method: 'browser', url: 'http://l.test/u', host: 'l.test' })
  })
  it('skips a malformed web URL and still offers the mailto', () => {
    expect(planUnsubscribe('<https://exa mple.com/u>, <mailto:u@l.test>', true)).toEqual({
      method: 'mailto', to: 'u@l.test', subject: 'unsubscribe', body: 'unsubscribe'
    })
    expect(planUnsubscribe('<https://>', true)).toBeNull()
    expect(parseListUnsubscribe('<https://exa mple.com/u>, <https://>')).toEqual({ web: [], mailto: [] })
  })
  it('has nothing for a message without the header', () => {
    expect(planUnsubscribe(null, false)).toBeNull()
  })
})

describe('runUnsubscribe', () => {
  const deps = () => ({
    post: vi.fn(async (_url: string) => true),
    sendMail: vi.fn((_to: string, _subject: string, _body: string) => {}),
    openUrl: vi.fn(async (_url: string) => {})
  })
  it('runs the chosen method only', async () => {
    const d = deps()
    expect(await runUnsubscribe({ method: 'post', url: 'https://l.test/u', host: 'l.test' }, d)).toEqual({ ok: true })
    expect(d.post).toHaveBeenCalledWith('https://l.test/u')
    expect(d.sendMail).not.toHaveBeenCalled()
  })
  it('reports a refused POST', async () => {
    const d = { ...deps(), post: vi.fn(async (_url: string) => false) }
    expect(await runUnsubscribe({ method: 'post', url: 'https://l.test/u', host: 'l.test' }, d)).toEqual({
      ok: false,
      error: 'l.test did not accept the request'
    })
  })
})

describe('one-click POST safety', () => {
  it('never POSTs to a local or private host; the browser plan shows the full URL instead', () => {
    for (const u of [
      'https://127.0.0.1:8443/u',
      'https://192.168.1.10/u',
      'https://10.0.0.1/u',
      'https://2130706433/u',
      'https://[::1]/u',
      'https://localhost/u',
      'https://printer.local/u',
      'https://intranet/u'
    ]) {
      expect(planUnsubscribe(`<${u}>`, true)?.method).toBe('browser')
    }
    expect(planUnsubscribe('<https://list.example.com/u>', true)?.method).toBe('post')
  })

  it('classifies hosts', () => {
    expect(isPublicPostHost('list.example.com')).toBe(true)
    expect(isPublicPostHost('169.254.169.254')).toBe(false)
    expect(isPublicPostHost('a.localhost')).toBe(false)
    expect(isPublicPostHost('[fe80::1]')).toBe(false)
  })

  it('does not follow redirects and counts only a 2xx as success', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 307, headers: { location: 'https://10.0.0.1/' } }))
    expect(await oneClickPost('https://l.test/u', fetchImpl as unknown as typeof fetch)).toBe(false)
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.redirect).toBe('manual')
    expect(init.method).toBe('POST')

    const ok = vi.fn(async () => new Response(null, { status: 204 }))
    expect(await oneClickPost('https://l.test/u', ok as unknown as typeof fetch)).toBe(true)
  })
})
