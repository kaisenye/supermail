import { describe, expect, it } from 'vitest'
import { isIgnoredFolder } from './syncEngine.js'

describe("Exmail's 其他文件夹", () => {
  it('skips the empty container but syncs the folders inside it', () => {
    expect(isIgnoredFolder('其他文件夹')).toBe(true)
    expect(isIgnoredFolder('其他文件夹/客户')).toBe(false)
    expect(isIgnoredFolder('其他文件夹/询价')).toBe(false)
    expect(isIgnoredFolder('INBOX')).toBe(false)
  })
})
