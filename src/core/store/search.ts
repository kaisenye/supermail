import { getDb } from './db.js'
import { LIST_COLS } from './repo.js'
import type { MessageListRow } from './types.js'

/** `field:value`, `field:"quoted value"`, `"bare phrase"`, or a bare term. */
const TOKEN_RE = /(\w+):("([^"]*)"|\S+)|"([^"]*)"|(\S+)/g

const TEXT_FIELDS = new Set(['from', 'to', 'subject', 'cc', 'body'])

/** Column each text operator matches against, LIKE'd on the messages table. */
const TEXT_COLS: Record<string, string> = {
  from: "COALESCE(m.from_addr,'') || ' ' || COALESCE(m.from_name,'')",
  to: "COALESCE(m.to_addrs,'')",
  cc: "COALESCE(m.cc_addrs,'')",
  subject: "COALESCE(m.subject,'')",
  body: "COALESCE(m.body_text,'')"
}

interface Parsed {
  terms: string[]
  predicates: { sql: string; params: unknown[] }[]
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

/**
 * Split a query into FTS terms and SQL predicates. Anything that isn't a
 * recognised operator falls through as a literal term, so `foo:bar` still searches.
 */
export function parseQuery(input: string): Parsed {
  const terms: string[] = []
  const predicates: Parsed['predicates'] = []

  for (const m of input.matchAll(TOKEN_RE)) {
    const field = m[1]?.toLowerCase()
    const value = m[3] ?? m[2] ?? m[4] ?? m[5] ?? ''

    if (field && TEXT_FIELDS.has(field) && value) {
      predicates.push({
        sql: `lower(${TEXT_COLS[field]}) LIKE ? ESCAPE '\\'`,
        params: [likeParam(value)]
      })
      continue
    }
    if (field === 'is') {
      const v = value.toLowerCase()
      if (v === 'unread' || v === 'read') {
        const f = hasFlagSql('\\seen')
        predicates.push({ sql: v === 'read' ? f.sql : `NOT ${f.sql}`, params: f.params })
        continue
      }
      if (v === 'starred' || v === 'flagged') {
        predicates.push(hasFlagSql('\\flagged'))
        continue
      }
    }
    if (field === 'has') {
      const v = value.toLowerCase()
      if (v === 'attachment' || v === 'attachments') {
        predicates.push({ sql: 'm.has_attachments = 1', params: [] })
        continue
      }
    }
    // Unrecognised operator or bare word — treat the whole token as text.
    terms.push(m[0])
  }

  return { terms, predicates }
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
  const { terms, predicates } = parseQuery(query)
  const fts = toFtsQuery(terms.join(' '))
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
  if (rows.length || predicates.length || !terms.length) return rows
  return fuzzySearch(accountId, terms, limit)
}
