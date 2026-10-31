export interface UnsubscribeTargets {
  /** http(s) URLs, in header order. Only https may be POSTed (RFC 8058). */
  web: string[]
  mailto: string[]
}

export function parseListUnsubscribe(header: string | null): UnsubscribeTargets {
  const out: UnsubscribeTargets = { web: [], mailto: [] }
  if (!header) return out
  for (const m of header.matchAll(/<([^>]+)>/g)) {
    const u = m[1].trim()
    if (/^https?:\/\//i.test(u)) {
      // Malformed URLs are dropped so a valid mailto in the same header still works.
      if (parsesAsUrl(u)) out.web.push(u)
    } else if (/^mailto:/i.test(u)) out.mailto.push(u)
  }
  return out
}

function parsesAsUrl(u: string): boolean {
  try {
    return Boolean(new URL(u).host)
  } catch {
    return false
  }
}

export function parseMailto(uri: string): { to: string; subject: string; body: string } | null {
  try {
    const u = new URL(uri)
    const to = decodeURIComponent(u.pathname)
    if (!/^[^@\s]+@[^@\s]+$/.test(to)) return null
    return {
      to,
      subject: u.searchParams.get('subject') || 'unsubscribe',
      body: u.searchParams.get('body') || 'unsubscribe'
    }
  } catch {
    return null
  }
}

export type UnsubscribePlan =
  | { method: 'post'; url: string; host: string }
  | { method: 'mailto'; to: string; subject: string; body: string }
  | { method: 'browser'; url: string; host: string }

/**
 * Whether main may POST to this host unprompted by a full URL. The header is
 * unauthenticated (no DKIM check), so a spoofed newsletter must not be able to
 * aim the user's machine at a LAN service: IP literals, localhost, mDNS
 * (.local) and single-label intranet names all fall back to the browser plan,
 * where the user sees the whole URL first.
 */
export function isPublicPostHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (!h) return false
  // [::1] and every other IPv6 literal.
  if (h.startsWith('[') || h.includes(':')) return false
  // The WHATWG parser normalises 2130706433, 0x7f.1 and friends to dotted quads.
  if (/^\d+(\.\d+){3}$/.test(h)) return false
  if (!h.includes('.')) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return false
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return false
  return true
}

/** One-click POST when offered over https to a public host, else an email, else the sender's page. */
export function planUnsubscribe(header: string | null, oneClick: boolean): UnsubscribePlan | null {
  const t = parseListUnsubscribe(header)
  const https = t.web.find((u) => /^https:\/\//i.test(u))
  if (oneClick && https && isPublicPostHost(new URL(https).hostname))
    return { method: 'post', url: https, host: new URL(https).host }
  for (const m of t.mailto) {
    const mt = parseMailto(m)
    if (mt) return { method: 'mailto', ...mt }
  }
  const web = https ?? t.web[0]
  return web ? { method: 'browser', url: web, host: new URL(web).host } : null
}

/** What the confirm dialog says will happen. */
export function describePlan(plan: UnsubscribePlan): string {
  if (plan.method === 'post') return `Sovo will send an unsubscribe request to ${plan.host}.`
  if (plan.method === 'mailto') return `Sovo will send an unsubscribe email to ${plan.to}.`
  return `This opens ${plan.host} in your browser to finish unsubscribing.`
}

/**
 * The RFC 8058 one-click POST. Redirects are not followed: the user confirmed
 * one host, and a 307/308 would carry the POST to whatever the sender picks
 * (including an https->http downgrade). One-click needs no redirect, so only
 * a 2xx counts.
 */
export async function oneClickPost(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const r = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000)
  })
  return r.status >= 200 && r.status < 300
}

export interface UnsubscribeDeps {
  post: (url: string) => Promise<boolean>
  sendMail: (to: string, subject: string, body: string) => void
  openUrl: (url: string) => Promise<void>
}

export async function runUnsubscribe(
  plan: UnsubscribePlan,
  deps: UnsubscribeDeps
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (plan.method === 'post') {
      return (await deps.post(plan.url))
        ? { ok: true }
        : { ok: false, error: `${plan.host} did not accept the request` }
    }
    if (plan.method === 'mailto') deps.sendMail(plan.to, plan.subject, plan.body)
    else await deps.openUrl(plan.url)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
