import { getDb } from './db.js'
import { LIST_COLS } from './repo.js'
import type { MessageListRow } from './types.js'

const TEXT_FIELDS = new Set(['from', 'to', 'subject', 'cc', 'body'])

/** Column each text operator matches against, LIKE'd on the messages table. */
const TEXT_COLS: Record<string, string> = {
  from: "COALESCE(m.from_addr,'') || ' ' || COALESCE(m.from_name,'')",
  to: "COALESCE(m.to_addrs,'')",
  cc: "COALESCE(m.cc_addrs,'')",
  subject: "COALESCE(m.subject,'')",
  body: "COALESCE(m.body_text,'')"
}

/** True when a JSON flags array contains `flag`, case-insensitively. */
function hasFlagSql(flag: string): { sql: string; params: unknown[] } {
  return {
    sql: `EXISTS (SELECT 1 FROM json_each(COALESCE(m.flags,'[]')) WHERE lower(json_each.value) = ?)`,
    params: [flag.toLowerCase()]
  }
}

function likeParam(v: string): string {
  // Escape LIKE wildcards so a literal % or _ in user input stays literal.
  return `%${v.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** `search` reads one message; `list` reads a list_rows row (alias lr) joined to its newest message (m). */
export type QueryContext = 'search' | 'list'

const VIP_SQL =
  'EXISTS (SELECT 1 FROM vip_senders v WHERE v.account_id = lr.account_id AND v.address = lr.sender)'
const REPLIED_SQL =
  'EXISTS (SELECT 1 FROM replied_senders rs WHERE rs.account_id = lr.account_id AND rs.address = lr.sender)'
/**
 * VIPs; else the classifier's verdict on the thread when there is one
 * (list_rows.ai_important, v21); else non-bulk mail from people you have
 * written to. Other is its exact complement.
 */
const IMPORTANT_SQL = `(${VIP_SQL} OR COALESCE(lr.ai_important = 1, lr.bulk = 0 AND ${REPLIED_SQL}))`

/** `is:` values that read thread state from list_rows. List context only. */
const LIST_IS: Record<string, string> = {
  unread: 'lr.unread_count > 0',
  read: 'lr.unread_count = 0',
  starred: 'lr.flagged = 1',
  flagged: 'lr.flagged = 1',
  'needs-reply': 'lr.last_from_me = 0 AND lr.bulk = 0',
  waiting: 'lr.last_from_me = 1',
  bulk: 'lr.bulk = 1',
  vip: VIP_SQL,
  important: IMPORTANT_SQL,
  other: `NOT ${IMPORTANT_SQL}`
}

/** Optional `-`, then `field:value`, `field:"quoted value"`, `"a phrase"`, or a bare term. */
const TOKEN_RE = /(-?)(?:(\w+):("([^"]*)"|\S+)|"([^"]*)"|(\S+))/g

type Pred = { sql: string; params: unknown[] }

interface Parsed {
  /** Positive bare words: one FTS match with phrases, prefix-matching the last word. */
  terms: string[]
  /** Positive "phrases": words in order. */
  phrases: string[]
  /** Everything else, ANDed: field operators, negations, OR groups. */
  predicates: Pred[]
}

type Atom =
  | { kind: 'term'; text: string }
  | { kind: 'phrase'; text: string }
  | { kind: 'pred'; pred: Pred }
  | { kind: 'or'; parts: Atom[] }

const FTS_IN = 'm.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)'

/** in: names that mean a role. Done is Archive, or All Mail on Gmail. */
const IN_ROLES: Record<string, string[]> = {
  inbox: ['inbox'],
  sent: ['sent'],
  drafts: ['drafts'],
  trash: ['trash'],
  bin: ['trash'],
  spam: ['junk'],
  junk: ['junk'],
  done: ['archive', 'all'],
  archive: ['archive', 'all']
}

/** YYYY-MM-DD or YYYY/MM/DD as local midnight, or null for anything else. */
export function parseDay(v: string): number | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d.getTime() : null
}

/** FTS5 phrase: the words in order, no prefix match. */
export function toFtsPhrase(input: string): string {
  const tokens = input.match(/[\p{L}\p{N}]+/gu)
  return tokens?.length ? `"${tokens.join(' ')}"` : ''
}

/** A recognised `field:value`, or null to treat the token as text. */
function operatorPred(field: string, value: string, ctx: QueryContext): Pred | null {
  if (!value) return null
  if (TEXT_FIELDS.has(field))
    return { sql: `lower(${TEXT_COLS[field]}) LIKE ? ESCAPE '\\'`, params: [likeParam(value)] }
  const v = value.toLowerCase()
  if (field === 'is') {
    if (ctx === 'list' && Object.hasOwn(LIST_IS, v)) return { sql: LIST_IS[v], params: [] }
    if (v === 'unread' || v === 'read') {
      const f = hasFlagSql('\\seen')
      return { sql: v === 'read' ? f.sql : `NOT ${f.sql}`, params: f.params }
    }
    if (v === 'starred' || v === 'flagged') return hasFlagSql('\\flagged')
    return null
  }
  if (field === 'has') return v === 'attachment' || v === 'attachments' ? { sql: 'm.has_attachments = 1', params: [] } : null
  if (field === 'in') {
    // Own keys only: `in:constructor` must not reach Object.prototype.
    const roles = Object.hasOwn(IN_ROLES, v) ? IN_ROLES[v] : undefined
    if (roles)
      return {
        sql: `m.folder_id IN (SELECT f.id FROM folders f WHERE f.account_id = m.account_id AND f.role IN (${roles.map(() => '?').join(',')}))`,
        params: roles
      }
    return {
      sql: 'm.folder_id IN (SELECT f.id FROM folders f WHERE f.account_id = m.account_id AND (lower(f.name) = ? OR lower(f.path) = ?))',
      params: [v, v]
    }
  }
  if (field === 'label')
    return {
      sql: `EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id
                     WHERE ml.message_id = m.id AND l.account_id = m.account_id AND lower(l.name) = ?)`,
      params: [v]
    }
  // The classifier's category (Phase 4), or one of the inbox's own labels
  // (v22) on any message of the thread. List context only: it reads list_rows.
  if (field === 'ai' && ctx === 'list')
    return {
      sql: `(lr.ai_category = ? OR EXISTS (
              SELECT 1 FROM ai_message_labels x
                JOIN ai_labels al ON al.id = x.label_id
                JOIN messages mx ON mx.account_id = x.account_id AND mx.message_id = x.message_id
               WHERE x.account_id = lr.account_id AND al.name = ?
                 AND COALESCE(mx.thread_id, '#' || mx.id) = lr.thread_key))`,
      params: [v, v]
    }
  if (field === 'before' || field === 'after') {
    const t = parseDay(value)
    if (t === null) return null
    return field === 'before' ? { sql: 'm.date < ?', params: [t] } : { sql: 'm.date >= ?', params: [t] }
  }
  return null
}

function atomPred(a: Atom): Pred | null {
  if (a.kind === 'pred') return a.pred
  if (a.kind === 'term') {
    const fts = toFtsQuery(a.text)
    return fts ? { sql: FTS_IN, params: [fts] } : null
  }
  if (a.kind === 'phrase') {
    const fts = toFtsPhrase(a.text)
    return fts ? { sql: FTS_IN, params: [fts] } : null
  }
  const parts = a.parts.map(atomPred).filter((p): p is Pred => p !== null)
  if (!parts.length) return null
  if (parts.length === 1) return parts[0]
  return { sql: `(${parts.map((p) => p.sql).join(' OR ')})`, params: parts.flatMap((p) => p.params) }
}

/** `-x`: a word or phrase must not appear (exact words, no prefix); an operator is NOTed. */
function negated(a: Atom): Atom | null {
  const p = a.kind === 'term' || a.kind === 'phrase' ? atomPred({ kind: 'phrase', text: a.text }) : atomPred(a)
  return p ? { kind: 'pred', pred: { sql: `NOT (${p.sql})`, params: p.params } } : null
}

/**
 * Split a query into FTS words / phrases and SQL predicates. Gmail syntax:
 * `a OR b` binds tighter than the implicit AND, `-` negates, quotes make a
 * phrase. Anything that isn't a recognised operator falls through as a
 * literal term, so `foo:bar` still searches.
 */
export function parseQuery(input: string, ctx: QueryContext = 'search'): Parsed {
  const items: (Atom | 'OR')[] = []
  for (const m of input.matchAll(TOKEN_RE)) {
    const neg = m[1] === '-'
    const field = m[2]?.toLowerCase()
    const value = m[4] ?? m[3] ?? ''
    const phrase = m[5]
    const bare = m[6]
    if (!neg && bare === 'OR') {
      items.push('OR')
      continue
    }
    let atom: Atom
    if (field) {
      const p = operatorPred(field, value, ctx)
      atom = p ? { kind: 'pred', pred: p } : { kind: 'term', text: m[0].slice(neg ? 1 : 0) }
    } else if (phrase !== undefined) atom = { kind: 'phrase', text: phrase }
    else atom = { kind: 'term', text: bare ?? '' }
    const final = neg ? negated(atom) : atom
    if (final) items.push(final)
  }

  // Fold `x OR y OR z` into one group. A dangling OR is ignored.
  const atoms: Atom[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it !== 'OR') {
      atoms.push(it)
      continue
    }
    const next = items[i + 1]
    const prev = atoms.pop()
    if (!prev || !next || next === 'OR') {
      if (prev) atoms.push(prev)
      continue
    }
    i++
    atoms.push({ kind: 'or', parts: [...(prev.kind === 'or' ? prev.parts : [prev]), next] })
  }

  const out: Parsed = { terms: [], phrases: [], predicates: [] }
  for (const a of atoms) {
    if (a.kind === 'term') out.terms.push(a.text)
    else if (a.kind === 'phrase') out.phrases.push(a.text)
    else {
      const p = atomPred(a)
      if (p) out.predicates.push(p)
    }
  }
  return out
}

/** The one FTS match a query's positive words and phrases make, or '' for none. */
export function ftsQueryOf(p: Pick<Parsed, 'terms' | 'phrases'>): string {
  return [toFtsQuery(p.terms.join(' ')), ...p.phrases.map(toFtsPhrase)].filter(Boolean).join(' ')
}

/**
 * FTS5 treats punctuation as syntax, so raw user input throws on typing
 * things like "re:" or "a@b.com". Quote each token and prefix-match the last.
 */
export function toFtsQuery(input: string): string {
  const tokens = input.match(/[\p{L}\p{N}]+/gu)
  if (!tokens?.length) return ''
  return tokens.map((t, i) => `"${t}"${i === tokens.length - 1 ? '*' : ''}`).join(' ')
}

/**
 * Column weights for bm25: a hit in the subject or sender means far more than
 * one buried in a long body. Lower bm25 score = better match.
 */
const BM25_WEIGHTS = '10.0, 6.0, 6.0, 1.0'

/**
 * Recency tie-breaker. Pure relevance surfaces two-year-old mail above this
 * week's, which is almost never what you want in an inbox — but it must only
 * nudge, never override, or searching becomes "sort by date".
 */
const RECENCY_SQL = `
  (bm25(messages_fts, ${BM25_WEIGHTS})
     - 2.0 * exp(-(strftime('%s','now') * 1000 - COALESCE(m.date, 0)) / 7776000000.0))
`

/** 3-grams of a term, which is what the trigram index actually stores. */
function trigrams(s: string): string[] {
  const t = s.toLowerCase()
  const out: string[] = []
  for (let i = 0; i + 3 <= t.length; i++) out.push(t.slice(i, i + 3))
  return out
}

/** Levenshtein, capped — only used to re-rank a handful of fuzzy candidates. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (!m || !n) return Math.max(m, n)
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    prev = cur
  }
  return prev[n]
}

/** How close is `term` to any word in `text`? Used to score fuzzy hits. */
function bestTokenDistance(term: string, text: string): number {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  let best = Infinity
  for (const w of words) {
    // Length gap alone exceeds the budget — skip the O(mn) walk.
    if (Math.abs(w.length - term.length) > 2) continue
    const d = editDistance(term, w)
    if (d < best) best = d
    if (best === 0) break
  }
  return best
}

/**
 * Typo-tolerant fallback. Only runs when exact search finds nothing, so a
 * correctly spelled query never pays for it. Candidates come from the trigram
 * index (cheap, indexed) and are then re-ranked by real edit distance so that
 * "meting" prefers "meeting" over "marching".
 */
function fuzzySearch(accountId: number, terms: string[], limit: number): MessageListRow[] {
  const grams = terms.flatMap(trigrams)
  if (!grams.length) return []

  const select = LIST_COLS.split(', ')
    .map((c) => `m.${c}`)
    .join(', ')
  const match = [...new Set(grams)].map((g) => `"${g.replace(/"/g, '')}"`).join(' OR ')

  const rows = getDb()
    .prepare(
      `SELECT ${select}, COALESCE(m.subject,'') || ' ' || COALESCE(m.from_name,'') ||
              ' ' || COALESCE(m.from_addr,'') AS haystack
         FROM messages_trgm t JOIN messages m ON m.id = t.rowid
        WHERE messages_trgm MATCH ? AND m.account_id = ?
        ORDER BY rank
        LIMIT ?`
    )
    .all(match, accountId, limit * 6) as (MessageListRow & { haystack: string })[]

  const MAX_EDITS = 2
  return rows
    .map((r) => {
      const worst = Math.max(...terms.map((t) => bestTokenDistance(t, r.haystack)))
      return { row: r, dist: worst }
    })
    .filter((x) => x.dist <= MAX_EDITS)
    .sort((a, b) => a.dist - b.dist || (b.row.date ?? 0) - (a.row.date ?? 0))
    .slice(0, limit)
    .map((x) => {
      const { haystack: _drop, ...row } = x.row
      return row as MessageListRow
    })
}

export function searchMessages(
  accountId: number,
  query: string,
  limit = 100
): MessageListRow[] {
  const parsed = parseQuery(query)
  const { terms, phrases, predicates } = parsed
  const fts = ftsQueryOf(parsed)
  if (!fts && !predicates.length) return []

  const select = LIST_COLS.split(', ')
    .map((c) => `m.${c}`)
    .join(', ')
  const where = predicates.map((p) => p.sql)
  const params: unknown[] = []

  // Bare terms drive the FTS index; field operators are plain SQL on `messages`
  // because to_addrs/cc_addrs are not in the FTS table.
  const from = fts
    ? 'messages_fts f JOIN messages m ON m.id = f.rowid'
    : 'messages m'
  if (fts) {
    where.unshift('messages_fts MATCH ?')
    params.push(fts)
  }
  for (const p of predicates) params.push(...p.params)
  // Appended last so it binds after every predicate param, whose order the
  // clauses above already fixed.
  where.push('m.account_id = ?')
  params.push(accountId)
  params.push(limit)

  const rows = getDb()
    .prepare(
      `SELECT ${select} FROM ${from}
       WHERE ${where.join(' AND ')}
       ORDER BY ${fts ? RECENCY_SQL : 'm.date DESC'} LIMIT ?`
    )
    .all(...params) as MessageListRow[]

  // Only fall back on a plain term query: with operators in play an empty
  // result is usually a real answer ("no unread from bob"), not a typo.
  if (rows.length || predicates.length || phrases.length || !terms.length) return rows
  return fuzzySearch(accountId, terms, limit)
}

/**
 * Extra WHERE for a list view: predicates from a list-context query, plus
 * bare words matched against the newest message through FTS. Starts with
 * ' AND ' so it appends to listView's WHERE; empty when there is nothing to add.
 */
export function listWhere(query: string): { sql: string; params: unknown[] } {
  const parsed = parseQuery(query, 'list')
  const { predicates } = parsed
  const parts: string[] = []
  const params: unknown[] = []
  for (const p of predicates) {
    parts.push(predicates.length > 1 ? `(${p.sql})` : p.sql)
    params.push(...p.params)
  }
  const fts = ftsQueryOf(parsed)
  if (fts) {
    parts.push('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)')
    params.push(fts)
  }
  return parts.length ? { sql: ` AND ${parts.join(' AND ')}`, params } : { sql: '', params: [] }
}
