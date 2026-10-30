// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onDialogEscape, onRecordKey } from './keyLayers.js'

const press = (key: string): void => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('Settings key layers', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => cleanups.splice(0).forEach((off) => off()))

  it('closes Settings on Esc when nothing is recording', () => {
    const onClose = vi.fn()
    cleanups.push(onDialogEscape(onClose))
    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('lets Esc cancel a recording even when Settings listened first', () => {
    const onClose = vi.fn()
    const record = vi.fn()
    // Settings registers on open (and again on every re-render); the recorder only once Change is clicked.
    cleanups.push(onDialogEscape(onClose))
    cleanups.push(onRecordKey(record))
    press('Escape')
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0].key).toBe('Escape')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('also wins when Settings re-registers after the recorder started', () => {
    const onClose = vi.fn()
    const record = vi.fn()
    cleanups.push(onRecordKey(record))
    cleanups.push(onDialogEscape(onClose))
    press('Escape')
    expect(record).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps the recorded key from reaching App hotkeys', () => {
    const hotkey = vi.fn()
    window.addEventListener('keydown', hotkey)
    cleanups.push(() => window.removeEventListener('keydown', hotkey))
    cleanups.push(onRecordKey(() => {}))
    press('k')
    expect(hotkey).not.toHaveBeenCalled()
  })

  it('closes Settings again once the recorder is removed', () => {
    const onClose = vi.fn()
    cleanups.push(onDialogEscape(onClose))
    onRecordKey(() => {})()
    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
