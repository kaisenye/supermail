import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { randomState } from './oauth.js'

const PAGE = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>Supermail</title>` +
  `<body style="font:15px -apple-system,sans-serif;padding:48px">${msg}</body>`

/**
 * RFC 8252 loopback redirect. Listens on 127.0.0.1 on a random port, opens the
 * consent page in the system browser, and resolves with the authorisation
 * code. `host` only changes the redirect URI's spelling: Microsoft's portal
 * cannot register an http 127.0.0.1 URI, so it gets `localhost`, which
 * browsers resolve back to this listener (Entra ignores the port for it).
 */
export function waitForRedirect(opts: {
  host: '127.0.0.1' | 'localhost'
  buildUrl: (redirectUri: string, state: string) => string
  openUrl: (url: string) => Promise<void>
  timeoutMs?: number
}): Promise<{ code: string; redirectUri: string }> {
  const state = randomState()
  return new Promise((resolve, reject) => {
    let redirectUri = ''
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const fail = (msg: string) => {
        res.writeHead(400, { 'content-type': 'text/html' }).end(PAGE(`Sign-in failed: ${msg}`))
        finish(new Error(msg))
      }
      if (url.searchParams.get('state') !== state) return fail('state mismatch')
      const error = url.searchParams.get('error')
      if (error) return fail(error)
      const code = url.searchParams.get('code')
      if (!code) return fail('no code returned')
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(PAGE('Signed in. You can close this tab and return to Supermail.'))
      finish(null, code)
    })

    const timer = setTimeout(() => finish(new Error('Sign-in timed out')), opts.timeoutMs ?? 5 * 60_000)
    function finish(err: Error | null, code?: string): void {
      clearTimeout(timer)
      server.close()
      if (err) reject(err)
      else resolve({ code: code!, redirectUri })
    }

    server.on('error', (e) => finish(e))
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      redirectUri = `http://${opts.host}:${port}/callback`
      opts.openUrl(opts.buildUrl(redirectUri, state)).catch((e: Error) => finish(e))
    })
  })
}
