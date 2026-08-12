import { describe, expect, it } from 'vitest'

/**
 * The click-through rules for links inside the editable description. The
 * description is contenteditable, so "open the link" and "edit the text" both
 * have to be reachable from a mouse.
 */
function shouldOpen(opts: {
  href: string | null
  altKey?: boolean
  detail?: number
  hasSelection?: boolean
}): boolean {
  const SAFE = /^(https?:|mailto:)/i
  if (!opts.href) return false
  if (opts.altKey) return false
  if ((opts.detail ?? 1) > 1) return false
  if (opts.hasSelection) return false
  return SAFE.test(opts.href)
}

describe('link click-through', () => {
  it('opens on a plain single click', () => {
    expect(shouldOpen({ href: 'https://linear.app' })).toBe(true)
  })

  it('opens mailto links', () => {
    expect(shouldOpen({ href: 'mailto:a@b.com' })).toBe(true)
  })

  it('ignores clicks that are not on a link', () => {
    expect(shouldOpen({ href: null })).toBe(false)
  })

  it('does not open on alt-click, so the caret can be placed', () => {
    expect(shouldOpen({ href: 'https://linear.app', altKey: true })).toBe(false)
  })

  it('does not open on double click, which selects a word', () => {
    expect(shouldOpen({ href: 'https://linear.app', detail: 2 })).toBe(false)
  })

  it('does not open when text is selected, which means editing', () => {
    expect(shouldOpen({ href: 'https://linear.app', hasSelection: true })).toBe(false)
  })

  it('refuses javascript: and other unsafe schemes', () => {
    expect(shouldOpen({ href: 'javascript:alert(1)' })).toBe(false)
    expect(shouldOpen({ href: 'file:///etc/passwd' })).toBe(false)
  })
})

/** Mirrors the guard in the shell:open IPC handler. */
function mainAccepts(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url)
}

describe('shell:open guard', () => {
  it('accepts what the editor allows, so no link silently fails', () => {
    for (const url of ['https://x.com', 'http://x.com', 'mailto:a@b.com']) {
      expect(mainAccepts(url)).toBe(true)
    }
  })

  it('still refuses dangerous schemes', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
      expect(mainAccepts(url)).toBe(false)
    }
  })
})
