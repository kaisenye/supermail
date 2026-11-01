import { describe, expect, it } from 'vitest'
import { listWhere, parseQuery } from './search.js'

describe('the split-query parser (list context)', () => {
  it('reads is:unread as the thread, not the newest message', () => {
    expect(parseQuery('is:unread', 'list').predicates).toEqual([
      { sql: 'lr.unread_count > 0', params: [] }
    ])
  })

  it('leaves search-context is:unread on message flags', () => {
    expect(parseQuery('is:unread').predicates[0].sql).toContain('json_each')
  })

  it('knows the thread-state operators only in a list', () => {
    for (const op of ['needs-reply', 'waiting', 'important', 'other', 'vip', 'bulk'])
      expect(parseQuery(`is:${op}`, 'list').predicates).toHaveLength(1)
    expect(parseQuery('is:needs-reply').terms).toEqual(['is:needs-reply'])
  })

  it('makes Other exactly the complement of Important', () => {
    const imp = parseQuery('is:important', 'list').predicates[0].sql
    expect(parseQuery('is:other', 'list').predicates[0].sql).toBe(`NOT ${imp}`)
  })

  it('ANDs a split and a chip, and keeps field operators on the newest message', () => {
    const w = listWhere('is:important is:unread from:bob')
    expect(w.sql.startsWith(' AND ')).toBe(true)
    expect(w.sql).toContain('lr.unread_count > 0')
    expect(w.sql).toContain('m.from_addr')
    expect(w.params).toEqual(['%bob%'])
  })

  it('sends bare words to the FTS index', () => {
    expect(listWhere('invoice')).toEqual({
      sql: ' AND m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)',
      params: ['"invoice"*']
    })
  })

  it('adds nothing for an empty query', () => {
    expect(listWhere('  ')).toEqual({ sql: '', params: [] })
  })
})

describe('the split-query parser, new operators', () => {
  it('groups OR operands, thread-state ones included', () => {
    const w = listWhere('is:unread OR is:starred')
    expect(w.sql).toBe(' AND (lr.unread_count > 0 OR lr.flagged = 1)')
    expect(w.params).toEqual([])
  })

  it('keeps bare words and phrases in one FTS match', () => {
    expect(listWhere('invoice "due soon"')).toEqual({
      sql: ' AND m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)',
      params: ['"invoice"* "due soon"']
    })
  })

  it('reads a negated operator as NOT', () => {
    expect(parseQuery('-is:unread', 'list').predicates).toEqual([{ sql: 'NOT (lr.unread_count > 0)', params: [] }])
  })

  it('reads ai:<category> from the list row, or an own label on the thread, and only in a list', () => {
    const [p] = parseQuery('ai:Billing', 'list').predicates
    expect(p.sql).toContain('lr.ai_category = ?')
    expect(p.sql).toContain('FROM ai_message_labels')
    expect(p.params).toEqual(['billing', 'billing'])
    expect(parseQuery('ai:billing').terms).toEqual(['ai:billing'])
  })

  it('lets the classifier verdict decide Important before the heuristic', () => {
    expect(parseQuery('is:important', 'list').predicates[0].sql).toContain('COALESCE(lr.ai_important = 1,')
  })
})
