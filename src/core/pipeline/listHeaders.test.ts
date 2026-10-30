import { describe, expect, it } from 'vitest'
import { headerValue, listHeadersFrom } from './listHeaders.js'

describe('listHeadersFrom', () => {
  it('reads a folded List-Unsubscribe and the one-click marker', () => {
    const raw =
      'Subject: hi\r\nList-Unsubscribe: <mailto:u@list.test?subject=stop>,\r\n <https://list.test/u/1>\r\n' +
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n'
    expect(listHeadersFrom(raw)).toEqual({
      unsubscribe: '<mailto:u@list.test?subject=stop>, <https://list.test/u/1>',
      oneClick: true,
      bulk: true
    })
  })

  it('treats List-Id, Precedence and Auto-Submitted as bulk', () => {
    expect(listHeadersFrom('List-Id: <dev.list.test>').bulk).toBe(true)
    expect(listHeadersFrom('Precedence: bulk').bulk).toBe(true)
    expect(listHeadersFrom('Auto-Submitted: auto-generated').bulk).toBe(true)
    expect(listHeadersFrom('Auto-Submitted: no').bulk).toBe(false)
  })

  it('finds nothing on a personal message', () => {
    expect(listHeadersFrom('From: a@b.test\r\nSubject: lunch?\r\n')).toEqual({
      unsubscribe: null,
      oneClick: false,
      bulk: false
    })
  })

  it('matches header names case-insensitively, and only whole names', () => {
    expect(headerValue('x-list-id: nope\r\nLIST-ID: yes', 'list-id')).toBe('yes')
  })
})
