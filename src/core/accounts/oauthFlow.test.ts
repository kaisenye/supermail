import { describe, expect, it } from 'vitest'
import { waitForRedirect } from './oauthFlow.js'

/** Plays the browser: follows the auth URL's redirect_uri with the given query. */
function browser(query: (state: string) => string) {
  return async (url: string): Promise<void> => {
    const u = new URL(url)
    const redirect = u.searchParams.get('redirect_uri')!.replace('localhost', '127.0.0.1')
    const res = await fetch(`${redirect}?${query(u.searchParams.get('state')!)}`)
    await res.text()
  }
}

const buildUrl = (redirectUri: string, state: string) =>
  `https://idp.test/auth?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`

describe('waitForRedirect', () => {
  it('returns the code when state matches', async () => {
    const r = await waitForRedirect({
      host: '127.0.0.1',
      buildUrl,
      openUrl: browser((s) => `code=abc&state=${s}`)
    })
    expect(r.code).toBe('abc')
    expect(r.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  })

  it('uses localhost in the redirect for Microsoft, still listening on 127.0.0.1', async () => {
    const r = await waitForRedirect({
      host: 'localhost',
      buildUrl,
      openUrl: browser((s) => `code=x&state=${s}`)
    })
    expect(r.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/)
  })

  it('rejects a mismatched state', async () => {
    await expect(
      waitForRedirect({ host: '127.0.0.1', buildUrl, openUrl: browser(() => 'code=abc&state=evil') })
    ).rejects.toThrow(/state/)
  })

  it('reports a denied consent', async () => {
    await expect(
      waitForRedirect({
        host: '127.0.0.1',
        buildUrl,
        openUrl: browser((s) => `error=access_denied&state=${s}`)
      })
    ).rejects.toThrow(/access_denied/)
  })

  it('escapes the error it echoes back into the page', async () => {
    // The flow rejects as soon as the callback lands, before the body is read,
    // so the page is awaited on its own.
    let page: Promise<string> = Promise.resolve('')
    await expect(
      waitForRedirect({
        host: '127.0.0.1',
        buildUrl,
        openUrl: async (url) => {
          const u = new URL(url)
          const err = encodeURIComponent('<img src=x onerror="alert(1)">')
          page = fetch(
            `${u.searchParams.get('redirect_uri')}?error=${err}&state=${u.searchParams.get('state')}`
          ).then((r) => r.text())
          await page
        }
      })
    ).rejects.toThrow()
    expect(await page).not.toContain('<img')
    expect(await page).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
  })

  it('times out if the browser never comes back', async () => {
    await expect(
      waitForRedirect({ host: '127.0.0.1', buildUrl, openUrl: async () => {}, timeoutMs: 50 })
    ).rejects.toThrow(/timed out/)
  })
})
