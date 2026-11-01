import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const body = readFileSync(join(__dirname, 'views/MessageBody.tsx'), 'utf8')
const main = readFileSync(join(__dirname, '../../electron/main.ts'), 'utf8')

describe('message body sandbox', () => {
  // Asserted on the attribute, not the file: the surrounding comment mentions
  // these tokens by name.
  const sandbox = body.match(/sandbox="([^"]*)"/)?.[1] ?? '(missing)'

  it('lets a clicked link ask to navigate', () => {
    expect(sandbox).toContain('allow-top-navigation-by-user-activation')
  })

  // Links carry target="_blank"; without allow-popups the sandbox drops the
  // click silently. The popup never opens: main denies every window.
  it('lets a target=_blank link ask for a window, still inside the sandbox', () => {
    expect(sandbox.split(/\s+/)).toContain('allow-popups')
    expect(sandbox).not.toContain('allow-popups-to-escape-sandbox')
  })

  // These two are what keep untrusted mail HTML harmless; the allowances
  // above are only safe because main refuses every destination.

  it('still refuses scripts', () => {
    expect(sandbox).not.toContain('allow-scripts')
    expect(body).toContain("script-src 'none'")
  })

  it('still refuses same-origin access', () => {
    expect(sandbox).not.toContain('allow-same-origin')
  })
})

describe('main navigation guards', () => {
  it('intercepts subframe navigation', () => {
    expect(main).toContain("win.webContents.on('will-frame-navigate'")
  })

  it('intercepts top-level navigation', () => {
    expect(main).toContain("win.webContents.on('will-navigate'")
  })

  it('denies new windows rather than opening them', () => {
    expect(main).toContain('setWindowOpenHandler')
    expect(main).toMatch(/action: 'deny'/)
  })

  it('opens only http(s) and mailto externally', () => {
    const fn = main.match(/const openOutside[\s\S]*?\n  \}/)
    expect(fn?.[0]).toMatch(/https\?/)
    expect(fn?.[0]).toContain('mailto:')
    expect(fn?.[0]).toContain('shell.openExternal')
  })
})
