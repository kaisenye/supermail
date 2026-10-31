import { describe, expect, it } from 'vitest'
import { dueLabel, parseQuickTask, taskSections } from './tasksView'

// Friday 30 Oct 2026, 10:00 local.
const NOW = new Date(2026, 9, 30, 10, 0).getTime()
const day = (offset: number): number => new Date(2026, 9, 30 + offset, 12, 0).getTime()

const t = (id: number, due: number | null, priority = 0, sort = id) => ({ id, due_at: due, priority, sort_order: sort, done_at: null })

describe('task sections', () => {
  it('buckets open tasks by due date, overdue first and undated last', () => {
    const s = taskSections([t(1, null), t(2, day(3)), t(3, day(-2)), t(4, day(0)), t(5, day(1))], NOW)
    expect(s.map((x) => [x.label, x.tasks.map((y) => y.id)])).toEqual([
      ['Overdue', [3]],
      ['Today', [4]],
      ['Upcoming', [5, 2]],
      ['No date', [1]]
    ])
  })

  it('orders a bucket by due date, then priority (urgent first, none last), then manual order', () => {
    const s = taskSections([t(1, day(2), 0, 1), t(2, day(2), 3, 2), t(3, day(2), 1, 3), t(4, day(1), 0, 4)], NOW)
    expect(s[0].tasks.map((x) => x.id)).toEqual([4, 3, 2, 1])
  })

  it('leaves out empty buckets', () => {
    expect(taskSections([], NOW)).toEqual([])
  })
})

describe('quick add', () => {
  it('reads a trailing today / tomorrow / next week as the due date', () => {
    expect(parseQuickTask('Call Bill today', NOW)).toEqual({ title: 'Call Bill', due_at: day(0) })
    expect(parseQuickTask('Send deck tomorrow', NOW)).toEqual({ title: 'Send deck', due_at: day(1) })
    // The coming Monday, from a Friday.
    expect(parseQuickTask('Plan Q1 next week', NOW)).toEqual({ title: 'Plan Q1', due_at: day(3) })
  })

  it('keeps the words when they are the whole title or mid-sentence', () => {
    expect(parseQuickTask('today', NOW)).toEqual({ title: 'today', due_at: null })
    expect(parseQuickTask('Review today’s numbers', NOW)).toEqual({ title: 'Review today’s numbers', due_at: null })
  })

  it('trims and rejects an empty title', () => {
    expect(parseQuickTask('   ', NOW)).toBeNull()
  })
})

describe('due label', () => {
  it('says when, relative close by and absolute further out', () => {
    expect(dueLabel(day(-1), NOW)).toEqual({ text: 'Yesterday', tone: 'overdue' })
    expect(dueLabel(day(-3), NOW)).toEqual({ text: '3 days overdue', tone: 'overdue' })
    expect(dueLabel(day(0), NOW)).toEqual({ text: 'Today', tone: 'soon' })
    expect(dueLabel(day(1), NOW)).toEqual({ text: 'Tomorrow', tone: 'soon' })
    expect(dueLabel(day(3), NOW).text).toBe('Monday')
    expect(dueLabel(day(20), NOW).text).toBe('Nov 19')
  })
})
