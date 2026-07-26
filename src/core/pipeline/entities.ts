import type { MsgCtx, Processor } from './types.js'

export interface Entities {
  orderNumbers?: string[]
  poNumbers?: string[]
  amounts?: { value: number; currency: string }[]
}

// Separators are matched explicitly: a bare `-` in a char class eats the hyphen
// of "PO-88421", and `No.` chars eat the "O" of "ORD-5567".
// "PO-88421" reads as one identifier, so the hyphen form keeps its prefix;
// "PO #123" and "PO: 123" are separators, so those yield the bare number.
const SEP = String.raw`(?:\s|#|:|no\.?|№)*`
const TOKEN = String.raw`[A-Z0-9][A-Z0-9-]{2,}`
// The prefix must be a standalone token. Without a trailing boundary, "Poltra"
// matches PO + "LTRA" and every capitalised PO-word becomes a fake PO number.
// A digit must appear somewhere in the id, which rules out ordinary words.
const PO_RE = new RegExp(
  String.raw`\b(P\.?O\.?|purchase\s+order)(-)?(?![A-Za-z])${SEP}(${TOKEN})`,
  'gi'
)
const ORDER_RE = new RegExp(
  String.raw`\b(?:order|订单号|订单)(?![A-Za-z])${SEP}-?\s*(${TOKEN})`,
  'gi'
)
const HAS_DIGIT = /\d/

/** Rejoin "PO" + "-" + "88421" so the stored id matches what the human sees. */
function poToken(prefix: string, hyphen: string, token: string): string {
  if (!hyphen) return token.toUpperCase()
  const norm = prefix.replace(/\./g, '').toUpperCase()
  return `${norm}-${token.toUpperCase()}`
}
const AMOUNT_RE =
  /(?:(USD|EUR|GBP|CNY|RMB|JPY)\s*|([$€£¥]))\s?([\d,]+(?:\.\d{1,2})?)/gi

const SYMBOL_CCY: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'CNY'
}

function uniq(v: string[]): string[] {
  return [...new Set(v)]
}

/**
 * Stage-1 placeholder for what Stage-2 AI will do properly. Regex only, so it
 * runs free at sync time and the `entities` column starts filling day 1.
 */
export function extractEntities(text: string): Entities | null {
  const out: Entities = {}

  const pos = uniq(
    [...text.matchAll(PO_RE)]
      .filter((m) => HAS_DIGIT.test(m[3]))
      .map((m) => poToken(m[1], m[2] ?? '', m[3]))
  )
  if (pos.length) out.poNumbers = pos

  const orders = uniq(
    [...text.matchAll(ORDER_RE)].filter((m) => HAS_DIGIT.test(m[1])).map((m) => m[1].toUpperCase())
  )
  // "purchase order 123" matches both patterns; keep it as a PO only. Compare
  // against the bare number too, since PO tokens may carry a "PO-" prefix.
  const bare = new Set(pos.map((p) => p.replace(/^P\.?O\.?-/i, '')))
  const orderOnly = orders.filter((o) => !pos.includes(o) && !bare.has(o))
  if (orderOnly.length) out.orderNumbers = orderOnly

  const amounts: { value: number; currency: string }[] = []
  for (const m of text.matchAll(AMOUNT_RE)) {
    const currency = m[1]?.toUpperCase() ?? SYMBOL_CCY[m[2]] ?? null
    const value = Number(m[3].replace(/,/g, ''))
    if (currency && Number.isFinite(value)) {
      amounts.push({ value, currency: currency === 'RMB' ? 'CNY' : currency })
    }
  }
  if (amounts.length) out.amounts = amounts

  return Object.keys(out).length ? out : null
}

export const entitiesProcessor: Processor = {
  name: 'entities',
  async run(ctx: MsgCtx): Promise<void> {
    const { draft } = ctx
    const text = [draft.subject, draft.body_text].filter(Boolean).join('\n')
    if (!text) return
    const found = extractEntities(text)
    if (found) draft.entities = JSON.stringify(found)
  }
}
