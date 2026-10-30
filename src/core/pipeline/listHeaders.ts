/** What the list headers of one message say. */
export interface ListHeaders {
  /** Raw List-Unsubscribe value, e.g. `<mailto:…>, <https://…>`. */
  unsubscribe: string | null
  /** RFC 8058: List-Unsubscribe-Post says a POST unsubscribes without a page. */
  oneClick: boolean
  /** Mailing list, newsletter or machine-sent: feeds the Other split. */
  bulk: boolean
}

/** One header's value from raw header text, unfolded. Case-insensitive; null when absent. */
export function headerValue(raw: string, name: string): string | null {
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ')
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(unfolded)
  return m ? m[1].trim() : null
}

export function listHeadersFrom(raw: string): ListHeaders {
  const unsubscribe = headerValue(raw, 'list-unsubscribe') || null
  const post = headerValue(raw, 'list-unsubscribe-post') ?? ''
  const precedence = (headerValue(raw, 'precedence') ?? '').toLowerCase()
  const autoSubmitted = (headerValue(raw, 'auto-submitted') ?? '').toLowerCase()
  return {
    unsubscribe,
    oneClick: /list-unsubscribe=one-click/i.test(post),
    bulk:
      unsubscribe !== null ||
      headerValue(raw, 'list-id') !== null ||
      /^(bulk|list|junk)$/.test(precedence) ||
      (autoSubmitted !== '' && autoSubmitted !== 'no')
  }
}
