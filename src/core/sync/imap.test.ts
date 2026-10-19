import type { ListResponse } from 'imapflow'
import { describe, expect, it } from 'vitest'
import { toMailboxInfo } from './imap.js'

const list = (o: Record<string, unknown>): ListResponse =>
  ({ path: 'X', name: 'X', flags: new Set<string>(), ...o }) as unknown as ListResponse

describe('toMailboxInfo', () => {
  it('drops special-use that imapflow guessed from the folder name', () => {
    const info = toMailboxInfo(list({ specialUse: '\\Archive', specialUseSource: 'name' }))
    expect(info.specialUse).toBeNull()
  })

  it('keeps special-use the server advertised', () => {
    const info = toMailboxInfo(list({ specialUse: '\\Sent', specialUseSource: 'extension' }))
    expect(info.specialUse).toBe('\\Sent')
  })

  it('keeps special-use when no source is reported', () => {
    expect(toMailboxInfo(list({ specialUse: '\\Sent' })).specialUse).toBe('\\Sent')
  })

  it('marks \\NoSelect containers as not selectable', () => {
    const info = toMailboxInfo(list({ flags: new Set(['\\NoSelect']) }))
    expect(info.selectable).toBe(false)
  })
})
