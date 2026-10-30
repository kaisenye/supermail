import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiInsights } from '../../../electron/preload'
import { shouldAutoSuggest, shouldAutoSummarize, shouldRecheckOnBody, summaryNote } from '../aiInsights'

export type AiBusy = 'summary' | 'replies' | null

/**
 * AI state for the open thread. Loads what is stored, and generates the
 * summary when the feature is on, none is cached and the thread is worth one
 * (more than one message, or one long one); likewise Instant Replies for a
 * message that qualifies. Results for a thread the user has already left are
 * dropped.
 */
export function useAiInsights(threadId: string, accountId: number | undefined) {
  const [insights, setInsights] = useState<AiInsights | null>(null)
  const [busy, setBusy] = useState<AiBusy>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const key = `${accountId ?? ''}:${threadId}`
  const current = useRef(key)
  current.current = key
  const latest = useRef(insights)
  latest.current = insights

  /** `manual` (⌘K) says so when there was nothing to summarize; the automatic run stays quiet. */
  const summarize = useCallback(
    async (manual = true) => {
      const mine = key
      setBusy('summary')
      setError(null)
      setNote(null)
      const r = await window.api.aiSummarize(threadId, accountId)
      if (current.current !== mine) return
      setBusy((b) => (b === 'summary' ? null : b))
      if (!r.ok) return setError(r.error)
      setInsights((i) => (i ? { ...i, summary: r.summary } : i))
      setNote(summaryNote(manual, r.summary))
    },
    [key, threadId, accountId]
  )

  /** Instant Replies on demand; the worker precomputes them for new mail. */
  const suggest = useCallback(async () => {
    const mine = key
    setBusy((b) => b ?? 'replies')
    const r = await window.api.aiSuggestReplies(threadId, accountId)
    if (current.current !== mine) return
    setBusy((b) => (b === 'replies' ? null : b))
    if (!r.ok) return setError(r.error)
    setInsights((i) => (i ? { ...i, replies: r.replies } : i))
  }, [key, threadId, accountId])

  const reload = useCallback(async () => {
    const mine = key
    const i = await window.api.aiInsights(threadId, accountId)
    if (current.current !== mine) return null
    setInsights(i)
    return i
  }, [key, threadId, accountId])

  const autoRun = useCallback(
    (i: AiInsights | null) => {
      if (shouldAutoSummarize(i)) void summarize(false)
      if (shouldAutoSuggest(i)) void suggest()
    },
    [summarize, suggest]
  )

  useEffect(() => {
    setInsights(null)
    setError(null)
    setNote(null)
    setBusy(null)
    void reload().then(autoRun)
  }, [reload, autoRun])

  // The worker may finish while the thread is open.
  useEffect(() => window.api.onAiUpdated(() => void reload()), [reload])

  /**
   * A message body finished loading: a lone message may now read as long
   * enough. Summary only: Instant Replies were already asked for on open.
   */
  const bodyLoaded = useCallback(() => {
    if (!shouldRecheckOnBody(latest.current)) return
    void reload().then((i) => {
      if (shouldAutoSummarize(i)) void summarize(false)
    })
  }, [reload, summarize])

  return { insights, busy, error, note, summarize, suggest, reload, bodyLoaded }
}
