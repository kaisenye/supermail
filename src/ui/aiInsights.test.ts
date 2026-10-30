import { describe, expect, it } from 'vitest'
import type { AiInsights } from '../../electron/preload'
import {
  replyPick,
  replySourceId,
  shouldAutoSuggest,
  shouldAutoSummarize,
  shouldRecheckOnBody,
  summaryNote,
  TOO_SHORT_NOTE
} from './aiInsights'

const on: AiInsights['features'] = { write: true, replies: true, summary: true, classify: true, ask: true }
const off: AiInsights['features'] = { ...on, summary: false }
const ins = (o: Partial<AiInsights>): AiInsights => ({
  features: on,
  summary: null,
  summarizable: true,
  classification: null,
  replyTarget: null,
  replies: null,
  ...o
})

describe('thread insights decisions', () => {
  it('auto-summarizes only a thread worth one, with nothing cached, while Summaries is on', () => {
    expect(shouldAutoSummarize(ins({}))).toBe(true)
    // A single short message: no run, so no "Summarizing…" flash and no second body fetch.
    expect(shouldAutoSummarize(ins({ summarizable: false }))).toBe(false)
    expect(shouldAutoSummarize(ins({ summary: 'Cached.' }))).toBe(false)
    expect(shouldAutoSummarize(ins({ features: off }))).toBe(false)
    expect(shouldAutoSummarize(null)).toBe(false)
  })

  it('re-reads after a body loads only while the thread still reads as too short', () => {
    expect(shouldRecheckOnBody(ins({ summarizable: false }))).toBe(true)
    expect(shouldRecheckOnBody(ins({ summarizable: true }))).toBe(false)
    expect(shouldRecheckOnBody(ins({ summarizable: false, summary: 'Cached.' }))).toBe(false)
    expect(shouldRecheckOnBody(ins({ summarizable: false, features: off }))).toBe(false)
    expect(shouldRecheckOnBody(null)).toBe(false)
  })

  it('tells a ⌘K run that came back empty why, and keeps the automatic run quiet', () => {
    expect(summaryNote(true, null)).toBe(TOO_SHORT_NOTE)
    expect(summaryNote(false, null)).toBeNull()
    expect(summaryNote(true, 'A line.')).toBeNull()
  })

  it('asks for Instant Replies only for a message that qualifies and has none cached', () => {
    expect(shouldAutoSuggest(ins({ replyTarget: 7 }))).toBe(true)
    expect(shouldAutoSuggest(ins({ replyTarget: null }))).toBe(false)
    expect(shouldAutoSuggest(ins({ replyTarget: 7, replies: { messageRowId: 7, options: ['Yes.'] } }))).toBe(false)
    expect(shouldAutoSuggest(ins({ replyTarget: 7, features: { ...on, replies: false } }))).toBe(false)
    expect(shouldAutoSuggest(null)).toBe(false)
  })

  it('carries the message an Instant Reply answers along with its text', () => {
    const i = ins({ replyTarget: 42, replies: { messageRowId: 42, options: ['Yes.', 'No.'] } })
    expect(replyPick(i, 0)).toEqual({ text: 'Yes.', messageRowId: 42 })
    expect(replyPick(i, 1)).toEqual({ text: 'No.', messageRowId: 42 })
    expect(replyPick(i, 2)).toBeNull()
    expect(replyPick(ins({}), 0)).toBeNull()
    expect(replyPick(null, 0)).toBeNull()
  })

  it('builds an Instant Reply from the message it was written for, not the opened row', () => {
    // Opened on my own Sent copy (row 5); the suggestion answers Ann's newer inbound (row 42).
    expect(replySourceId(5, { text: 'Yes.', messageRowId: 42 })).toBe(42)
    // A plain reply still answers the opened row.
    expect(replySourceId(5)).toBe(5)
  })
})
