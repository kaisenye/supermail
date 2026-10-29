import { describe, expect, it } from 'vitest'
import { shouldSyncFolder } from './folderFilter.js'

const f = (path: string, role: string | null) => ({ path, role: role as never })

describe('shouldSyncFolder', () => {
  it('syncs every folder on a plain IMAP server', () => {
    expect(shouldSyncFolder('imap', f('客户', null))).toBe(true)
    expect(shouldSyncFolder('imap', f('Archive', 'archive'))).toBe(true)
  })

  it('syncs only system folders on Gmail', () => {
    expect(shouldSyncFolder('gmail', f('INBOX', 'inbox'))).toBe(true)
    expect(shouldSyncFolder('gmail', f('[Gmail]/Sent Mail', 'sent'))).toBe(true)
    expect(shouldSyncFolder('gmail', f('[Gmail]/Drafts', 'drafts'))).toBe(true)
    expect(shouldSyncFolder('gmail', f('[Gmail]/Trash', 'trash'))).toBe(true)
    expect(shouldSyncFolder('gmail', f('[Gmail]/Spam', 'junk'))).toBe(true)
  })

  it('skips All Mail and user labels on Gmail, which duplicate the same messages', () => {
    expect(shouldSyncFolder('gmail', f('[Gmail]/All Mail', 'all'))).toBe(false)
    expect(shouldSyncFolder('gmail', f('[Gmail]/Starred', null))).toBe(false)
    expect(shouldSyncFolder('gmail', f('Receipts', null))).toBe(false)
  })

  it('syncs every folder on Microsoft, where folders are real folders', () => {
    expect(shouldSyncFolder('microsoft', f('Projects', null))).toBe(true)
  })
})
