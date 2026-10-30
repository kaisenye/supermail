export interface IntroFields {
  to: string
  cc: string
  bcc: string
  body: string
}

function split(s: string): string[] {
  return s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function addrOf(entry: string): string {
  const m = /<([^>]+)>\s*$/.exec(entry)
  return (m ? m[1] : entry).trim().toLowerCase()
}

function firstNameOf(entry: string): string {
  const m = /^(.*?)<[^>]+>\s*$/.exec(entry)
  const name = m ? m[1].trim().replace(/^"|"$/g, '').trim() : ''
  if (name) return name.split(/\s+/)[0]
  const local = addrOf(entry).split('@')[0]
  const first = local.split(/[._+-]/).find(Boolean) ?? local
  return first.charAt(0).toUpperCase() + first.slice(1)
}

/**
 * A recipient as "Name <addr>" when the name is known, so Instant Intro can
 * greet people by name. Commas, semicolons, quotes and angle brackets are
 * dropped from the name: recipient lists are split on , and ;.
 */
export function namedAddress(name: string | null | undefined, addr: string): string {
  const clean = (name ?? '').replace(/[,;"<>]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean && addr ? `${clean} <${addr}>` : addr
}

/**
 * One stored address column as display entries. Synced mail holds the JSON
 * array parse.ts writes (`[{"address","name"}]`); local drafts hold a plain
 * "a@x, B <b@x>" string, so anything that is not a JSON array is split on , and ;.
 */
export function parseAddrColumn(value: string | null | undefined): { address: string; entry: string }[] {
  if (!value) return []
  let list: unknown
  try {
    list = JSON.parse(value)
  } catch {
    list = null
  }
  if (Array.isArray(list)) {
    const out: { address: string; entry: string }[] = []
    for (const a of list as { address?: unknown; name?: unknown }[]) {
      const address = typeof a?.address === 'string' ? a.address.trim() : ''
      if (!address) continue
      const name = typeof a?.name === 'string' ? a.name : null
      out.push({ address: address.toLowerCase(), entry: namedAddress(name, address) })
    }
    return out
  }
  return split(value).map((entry) => ({ address: addrOf(entry), entry }))
}

/**
 * Reply all's Cc: everyone on To and Cc except the addresses in `exclude`
 * (the account that received it, the sender who becomes the To), deduped by
 * address.
 */
export function replyAllCc(
  toAddrs: string | null | undefined,
  ccAddrs: string | null | undefined,
  exclude: (string | null | undefined)[]
): string {
  const skip = new Set(exclude.filter((x): x is string => !!x).map((x) => x.trim().toLowerCase()))
  const out: string[] = []
  for (const { address, entry } of [...parseAddrColumn(toAddrs), ...parseAddrColumn(ccAddrs)]) {
    if (skip.has(address)) continue
    skip.add(address)
    out.push(entry)
  }
  return out.join(', ')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Superhuman's Instant Intro (⌘⇧I), for replying to an introduction: the
 * person who made the intro (first To, the sender in a reply all) moves to
 * Bcc with a thank-you line, and the person introduced becomes the To.
 * Null when nobody would be left to write to.
 */
export function instantIntro(f: IntroFields): IntroFields | null {
  const [introducer, ...restTo] = split(f.to)
  if (!introducer) return null
  const cc = split(f.cc)
  const to = restTo.length ? restTo : cc.slice(0, 1)
  const keepCc = restTo.length ? cc : cc.slice(1)
  if (!to.length) return null
  const bcc = [...split(f.bcc).filter((a) => addrOf(a) !== addrOf(introducer)), introducer]
  return {
    to: to.join(', '),
    cc: keepCc.join(', '),
    bcc: bcc.join(', '),
    body: `<p>Thanks ${escapeHtml(firstNameOf(introducer))}! (Moving you to Bcc.)</p>${f.body}`
  }
}
