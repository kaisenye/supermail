// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiWriteMenu } from './AiWriteMenu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const onRun = vi.fn()
const onClose = vi.fn()

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<AiWriteMenu scope="message" busy={false} error={null} onRun={onRun} onClose={onClose} />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  onRun.mockReset()
  onClose.mockReset()
})

const input = (): HTMLInputElement => host.querySelector('input')!

/** Sets the controlled input's value the way typing does, so React's onChange runs. */
function type(text: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(input(), text)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

describe('Write with AI menu and an IME', () => {
  it('does not send the instruction on the Enter that confirms a candidate', () => {
    type('帮我回复')
    press('Enter', { isComposing: true })
    press('Enter', { keyCode: 229 })
    expect(onRun).not.toHaveBeenCalled()
    press('Enter')
    expect(onRun).toHaveBeenCalledExactlyOnceWith('draft', '帮我回复')
  })

  it('does not close on the Esc that cancels a composition', () => {
    press('Escape', { isComposing: true })
    expect(onClose).not.toHaveBeenCalled()
    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not move the rewrite choice on composing arrow keys', () => {
    press('ArrowDown', { isComposing: true })
    press('Enter')
    expect(onRun).not.toHaveBeenCalled()
    press('ArrowDown')
    press('Enter')
    expect(onRun).toHaveBeenCalledExactlyOnceWith('shorten')
  })
})

describe('Write with AI menu focus', () => {
  it('closes on Esc pressed outside its input, such as back in the body', () => {
    const body = document.createElement('div')
    body.tabIndex = 0
    document.body.appendChild(body)
    body.focus()
    act(() => {
      body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    body.remove()
  })

  it('does not close on an outside Esc that cancels a composition', () => {
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes once, not twice, on Esc in its own input', () => {
    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('takes focus back when asked again (⌘J while open)', () => {
    act(() => root.render(<AiWriteMenu scope="message" busy={false} error={null} onRun={onRun} onClose={onClose} focusKey={0} />))
    input().blur()
    expect(document.activeElement).not.toBe(input())
    act(() => root.render(<AiWriteMenu scope="message" busy={false} error={null} onRun={onRun} onClose={onClose} focusKey={1} />))
    expect(document.activeElement).toBe(input())
  })
})
