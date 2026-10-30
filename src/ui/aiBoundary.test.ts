import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
  })
}

/** Module specifiers of value (non-type) imports. */
function valueImports(src: string): string[] {
  return [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
}

const FORBIDDEN = /^(@anthropic-ai\/sdk|openai)(\/|$)|core\/services\/ai|core\/ai\//

describe('AI stays in main', () => {
  it('never imports a provider SDK or AI runtime code in the renderer', () => {
    const bad = files(join(process.cwd(), 'src/ui')).flatMap((f) =>
      valueImports(readFileSync(f, 'utf8'))
        .filter((s) => FORBIDDEN.test(s))
        .map((s) => `${f}: ${s}`)
    )
    expect(bad).toEqual([])
  })

  it('imports only types from the AI modules in the preload', () => {
    const src = readFileSync(join(process.cwd(), 'electron/preload.ts'), 'utf8')
    expect(valueImports(src).filter((s) => FORBIDDEN.test(s))).toEqual([])
  })
})
