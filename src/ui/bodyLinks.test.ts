import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const body = readFileSync(join(__dirname, 'views/MessageBody.tsx'), 'utf8')
const main = readFileSync(join(__dirname, '../../electron/main.ts'), 'utf8')

describe('message body sandbox', () => {
  it('lets a clicked link ask to navigate', () => {
    expect(body).toContain('sandbox="allow-top-navigation-by-user-activation"')
  })

  // These two are what keep untrusted mail HTML harmless; the navigation
  // allowance above is only safe because main refuses every destination.
  // Asserted on the attribute, not the file: the surrounding comment mentions
  // both tokens by name.
  const sandbox = body.match(/sandbox="([^"]*)"/)?.[1] ?? '(missing)'

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
