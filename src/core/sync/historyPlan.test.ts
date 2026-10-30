import { describe, expect, it } from 'vitest'
import { nextHistoryFolder } from './historyPlan.js'

const f = (id: number, path: string, role: string | null, history_complete = 0) =>
  ({ id, path, role, history_complete }) as Parameters<typeof nextHistoryFolder>[0][number]

describe('nextHistoryFolder', () => {
  it('walks Inbox, Sent, Done, other folders by path, then Trash / Junk / Drafts', () => {
    const all = [
      f(1, 'Trash', 'trash'),
      f(2, 'Zeta', null),
      f(3, 'Sent', 'sent'),
      f(4, 'Alpha', null),
      f(5, 'Archive', 'archive'),
      f(6, 'INBOX', 'inbox')
    ]
    const order: number[] = []
    let left = all
    for (let next = nextHistoryFolder(left); next; next = nextHistoryFolder(left)) {
      order.push(next.id)
      left = left.map((x) => (x.id === next!.id ? { ...x, history_complete: 1 } : x))
    }
    expect(order).toEqual([6, 3, 5, 4, 2, 1])
  })

  it('is null when every folder is complete', () => {
    expect(nextHistoryFolder([f(1, 'INBOX', 'inbox', 1)])).toBeNull()
    expect(nextHistoryFolder([])).toBeNull()
  })
})
