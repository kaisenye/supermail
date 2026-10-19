import { describe, expect, it } from 'vitest'
import { assignRoles } from './folderRoles.js'

const box = (path: string, specialUse: string | null = null) => ({ path, specialUse })

describe('assignRoles', () => {
  it('maps Exmail folders, which advertise no SPECIAL-USE', () => {
    const roles = assignRoles([
      box('INBOX'),
      box('Sent Messages'),
      box('Drafts'),
      box('Deleted Messages'),
      box('Junk'),
      box('客户')
    ])
    expect(Object.fromEntries(roles)).toEqual({
      INBOX: 'inbox',
      'Sent Messages': 'sent',
      Drafts: 'drafts',
      'Deleted Messages': 'trash',
      Junk: 'junk'
    })
  })

  it('prefers SPECIAL-USE over a matching name', () => {
    const roles = assignRoles([box('Sent'), box('[Gmail]/Sent Mail', '\\Sent')])
    expect(roles.get('[Gmail]/Sent Mail')).toBe('sent')
    expect(roles.has('Sent')).toBe(false)
  })

  it('maps Gmail system folders', () => {
    const roles = assignRoles([
      box('INBOX', '\\Inbox'),
      box('[Gmail]/All Mail', '\\All'),
      box('[Gmail]/Spam', '\\Junk'),
      box('[Gmail]/Trash', '\\Trash'),
      box('[Gmail]/Drafts', '\\Drafts')
    ])
    expect(roles.get('[Gmail]/All Mail')).toBe('all')
    expect(roles.get('[Gmail]/Spam')).toBe('junk')
    expect(roles.get('[Gmail]/Trash')).toBe('trash')
    expect(roles.get('[Gmail]/Drafts')).toBe('drafts')
  })

  it('maps Outlook names', () => {
    const roles = assignRoles([
      box('Sent Items'),
      box('Deleted Items'),
      box('Junk Email'),
      box('Archive')
    ])
    expect(roles.get('Sent Items')).toBe('sent')
    expect(roles.get('Deleted Items')).toBe('trash')
    expect(roles.get('Junk Email')).toBe('junk')
    expect(roles.get('Archive')).toBe('archive')
  })

  it('reads children of INBOX on dot-delimited servers', () => {
    expect(assignRoles([box('INBOX'), box('INBOX.Sent')]).get('INBOX.Sent')).toBe('sent')
  })

  it('never gives a nested user folder a role from its name', () => {
    expect(assignRoles([box('Projects/Archive')]).has('Projects/Archive')).toBe(false)
  })

  it('keeps the old preference order when two names match', () => {
    // Exmail order: "Deleted Messages" beat "Trash" in the old TRASH_PATHS.
    const roles = assignRoles([box('Trash'), box('Deleted Messages')])
    expect(roles.get('Deleted Messages')).toBe('trash')
    expect(roles.has('Trash')).toBe(false)
  })

  it('gives each role to one folder only', () => {
    const roles = assignRoles([box('A', '\\Sent'), box('B', '\\Sent')])
    expect([...roles.values()].filter((r) => r === 'sent')).toHaveLength(1)
  })
})
