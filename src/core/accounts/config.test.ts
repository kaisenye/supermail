import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadAccountConfig } from './config.js'

const envFile = (body: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'env-')), '.env.local')
  writeFileSync(path, body)
  return path
}

describe('loadAccountConfig env names', () => {
  it('reads SOVO_*', () => {
    const c = loadAccountConfig(envFile('SOVO_EMAIL=a@x.test\nSOVO_PASS=p\nSOVO_NAME=Kai'))
    expect(c.email).toBe('a@x.test')
    expect(c.name).toBe('Kai')
  })

  it('still reads the older SUPERMAIL_* and ROMO_* names', () => {
    expect(loadAccountConfig(envFile('SUPERMAIL_EMAIL=b@x.test\nSUPERMAIL_PASS=p')).email).toBe('b@x.test')
    expect(loadAccountConfig(envFile('ROMO_EMAIL=c@x.test\nROMO_PASS=p')).email).toBe('c@x.test')
  })
})
