import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * A thread is unread when any message in it is, so the toggle has to read the
 * rollup rather than the newest message's own flags.
 */
function anyUnread(rows: { flags: string | null; thread_unread?: number }[]): boolean {
  return rows.some((r) =>
    r.thread_unread === undefined
      ? !JSON.parse(r.flags ?? '[]').some((f: string) => f.toLowerCase() === '\\seen')
      : r.thread_unread > 0
  )
}

const SEEN = '["\\\\Seen"]'

describe('read/unread scope', () => {
  it('treats a thread with one unread message as unread', () => {
    expect(anyUnread([{ flags: SEEN, thread_unread: 1 }])).toBe(true)
  })

  it('treats a fully seen thread as read', () => {
    expect(anyUnread([{ flags: SEEN, thread_unread: 0 }])).toBe(false)
  })

  it('marks read when any selected thread still has unread mail', () => {
    expect(
      anyUnread([
        { flags: SEEN, thread_unread: 0 },
        { flags: SEEN, thread_unread: 4 }
      ])
    ).toBe(true)
  })

  /** Drafts and search stay flat, so no rollup: fall back to the row's flags. */
  it('falls back to the row flags when there is no rollup', () => {
    expect(anyUnread([{ flags: '[]' }])).toBe(true)
    expect(anyUnread([{ flags: SEEN }])).toBe(false)
  })
})

describe('action bar wiring', () => {
  // The hotkey and the buttons drifted apart once: u was thread-scoped while
  // the buttons still set \Seen on a single message.
  const app = readFileSync(join(__dirname, 'App.tsx'), 'utf8')

  it('routes both buttons through the thread-scoped helper', () => {
    expect(app).toContain('onMarkRead={() => void setThreadsRead(true)}')
    expect(app).toContain('onMarkUnread={() => void setThreadsRead(false)}')
  })

  it('never sets \\Seen on message ids from the action bar', () => {
    expect(app).not.toMatch(/onMark(Read|Unread)=\{\(\) => void applyFlags/)
  })
})
