import type { Ai } from '../services/ai/service.js'
import { localDay } from '../services/ai/service.js'
import { AiError, type AiRequest } from '../services/ai/types.js'
import { getDb } from '../store/db.js'
import { asData, MAIL_IS_DATA, messageText, who } from './mailText.js'

const STOP = new Set(
  (
    'a about after again all also am an and any anything are as at be been before but by can could did do does email ' +
    'emails for from get got had has have he her him his how i if in into is it its last latest me message messages mail ' +
    'my no not of on or our recent said say send sent she should show so some tell than that the their them then there ' +
    'these this those to us was we were what when where which who whom why will with would you your'
  ).split(' ')
)

const HAN = /\p{Script=Han}/u
/** Chinese function words that glue a question together; a Han run is cut at each one. */
const HAN_STOP = /多少|什么|[的是吗呢了我你在哪]/gu

/** The words of a question worth searching for, at most eight. */
export function askTerms(question: string): string[] {
  const words = question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const out: string[] = []
  for (const word of words) {
    const parts = HAN.test(word) ? word.split(HAN_STOP) : [word]
    for (const w of parts) {
      // One character left over from a cut (们 of 我们) matches nearly all
      // Chinese mail; only a one-character question as typed is kept.
      const single = [...w].length < 2 && (!HAN.test(w) || parts.length > 1)
      if (!w || STOP.has(w) || single || out.includes(w)) continue
      out.push(w)
      if (out.length === 8) return out
    }
  }
  return out
}

export interface AskSource {
  /** The number the answer cites, [n]. */
  n: number
  id: number
  account_id: number
  thread_id: string | null
  subject: string | null
  from_name: string | null
  from_addr: string | null
  date: number | null
}

type Hit = Omit<AskSource, 'n'> & { body_text: string | null; body_html: string | null; snippet: string | null }

const HIT_COLS = `m.id, m.account_id, m.thread_id, m.subject, m.from_name, m.from_addr, m.date,
              m.body_text, m.body_html, m.snippet`

/** The 3-character windows of each Han term — what the trigram index can match inside a run. */
export function hanGrams(terms: string[]): string[] {
  const out = new Set<string>()
  for (const t of terms) {
    if (!HAN.test(t)) continue
    const cs = [...t]
    for (let i = 0; i + 3 <= cs.length; i++) out.add(cs.slice(i, i + 3).join(''))
  }
  return [...out]
}

/** Han terms too short for a trigram window, like 发票; these fall back to a substring scan. */
export function shortHan(terms: string[]): string[] {
  return terms.filter((t) => HAN.test(t) && [...t].length < 3)
}

/**
 * Local search over every given account: any of the words, best match first, one hit per conversation.
 * unicode61 keeps a run of Han characters as one token, so a Chinese question only matches a
 * message whose run starts with it; Han terms also go through the trigram index, by window,
 * and terms under three characters (too short for a window) through a bounded substring scan.
 */
export function retrieveForAsk(accountIds: number[], question: string, limit = 10): (AskSource & { text: string })[] {
  const terms = askTerms(question)
  if (!terms.length || !accountIds.length) return []
  const inAccounts = `m.account_id IN (${accountIds.map(() => '?').join(',')})`
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT ${HIT_COLS}
         FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
        WHERE messages_fts MATCH ? AND m.folder_id IS NOT NULL AND ${inAccounts}
        ORDER BY bm25(messages_fts, 10.0, 6.0, 6.0, 1.0)
        LIMIT ?`
    )
    .all(terms.map((t) => `"${t}"*`).join(' OR '), ...accountIds, limit * 4) as Hit[]
  const grams = hanGrams(terms)
  if (grams.length) {
    const trgm = db
      .prepare(
        `SELECT ${HIT_COLS}
           FROM messages_trgm t JOIN messages m ON m.id = t.rowid
          WHERE messages_trgm MATCH ? AND m.folder_id IS NOT NULL AND ${inAccounts}
          ORDER BY rank
          LIMIT ?`
      )
      .all(grams.map((g) => `"${g.replace(/"/g, '')}"`).join(' OR '), ...accountIds, limit * 4) as Hit[]
    rows.push(...trgm)
  }
  const short = shortHan(terms)
  if (short.length) {
    // Terms are letters and digits only (askTerms), so no LIKE wildcard can sneak in.
    const like = db
      .prepare(
        `SELECT ${HIT_COLS}
           FROM messages m
          WHERE (${short.map(() => '(m.subject LIKE ? OR m.body_text LIKE ?)').join(' OR ')})
            AND m.folder_id IS NOT NULL AND ${inAccounts}
          ORDER BY m.date DESC
          LIMIT ?`
      )
      .all(...short.flatMap((t) => [`%${t}%`, `%${t}%`]), ...accountIds, limit * 4) as Hit[]
    rows.push(...like)
  }
  const seen = new Set<string>()
  const out: (AskSource & { text: string })[] = []
  for (const r of rows) {
    const key = `${r.account_id}:${r.thread_id ?? `#${r.id}`}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      n: out.length + 1,
      id: r.id,
      account_id: r.account_id,
      thread_id: r.thread_id,
      subject: r.subject,
      from_name: r.from_name,
      from_addr: r.from_addr,
      date: r.date,
      text: messageText(r, 1500)
    })
    if (out.length >= limit) break
  }
  return out
}

const attr = (s: string): string => s.replace(/"/g, '')

export function askRequest(question: string, sources: (AskSource & { text: string })[], now: number): AiRequest {
  const blocks = sources.map((s) => {
    const date = s.date ? new Date(s.date).toISOString().slice(0, 10) : 'unknown'
    return `<message n="${s.n}" from="${attr(who(s))}" date="${date}" subject="${attr(s.subject ?? '')}">\n${asData(s.text)}\n</message>`
  })
  return {
    system: [
      "You answer questions about the user's email using only the numbered messages provided.",
      'Cite the messages you used like [2].',
      'If they do not contain the answer, say so in one sentence.',
      'Be brief: at most five sentences or a short list.',
      MAIL_IS_DATA
    ].join(' '),
    prompt: `Today is ${localDay(now)}.\n\n${blocks.join('\n')}\n\nQuestion: ${question}`,
    maxTokens: 4000
  }
}

export async function askMail(
  ai: Ai,
  accountIds: number[],
  question: string,
  now = Date.now()
): Promise<{ answer: string; sources: AskSource[] }> {
  const q = question.trim()
  if (!q) throw new AiError('invalid', 'Ask a question')
  const found = retrieveForAsk(accountIds, q)
  if (!found.length)
    return { answer: 'Nothing in your local mail matches that. Try a name, a company or a word from the subject.', sources: [] }
  const r = await ai.run('ask', askRequest(q, found, now))
  return {
    answer: r.text.trim(),
    sources: found.map((x) => {
      const { text: _drop, ...s } = x
      return s
    })
  }
}
