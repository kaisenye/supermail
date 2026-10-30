import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { WriteAction } from '../../../electron/preload'
import { isImeKey } from '../ime'

const ACTIONS: { id: Exclude<WriteAction, 'draft'>; label: string }[] = [
  { id: 'shorten', label: 'Shorten' },
  { id: 'fix', label: 'Fix spelling and grammar' },
  { id: 'friendlier', label: 'Make it friendlier' },
  { id: 'formal', label: 'Make it more formal' }
]

interface Props {
  /** What the result replaces: the selection, or the message above the signature. */
  scope: 'selection' | 'message'
  busy: boolean
  error: string | null
  onRun: (action: WriteAction, instruction?: string) => void
  onClose: () => void
  /** Changing it moves focus back to the input (⌘J while the menu is open). */
  focusKey?: number
}

/** Type what to write and press ↵, or pick a rewrite with ↑ / ↓. Esc closes. */
export function AiWriteMenu({ scope, busy, error, onRun, onClose, focusKey = 0 }: Props) {
  const [text, setText] = useState('')
  const [active, setActive] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [focusKey])

  // Esc pressed with focus elsewhere (back in the body) still closes the menu;
  // Compose's own Escape listener stands down while the menu is open.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape' || isImeKey(e) || e.target === inputRef.current) return
      e.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    // The Enter that confirms a Pinyin candidate must not send half-typed text; Esc only cancels the composition.
    if (isImeKey(e.nativeEvent)) return
    if (e.key === 'Escape') {
      // Must not reach Compose's Escape listener, which would discard the draft view.
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (busy) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(ACTIONS.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(-1, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (active >= 0) onRun(ACTIONS[active].id)
      else if (text.trim()) onRun('draft', text.trim())
    }
  }

  return (
    <div className="ai-write" role="dialog" aria-label="Write with AI">
      <input
        ref={inputRef}
        className="ai-write-input"
        value={text}
        readOnly={busy}
        aria-label="What to write"
        placeholder={scope === 'selection' ? 'Tell AI what to write instead of the selection…' : 'Tell AI what to write…'}
        onChange={(e) => {
          setText(e.target.value)
          setActive(-1)
        }}
        onKeyDown={onKeyDown}
      />
      <ul className="ai-write-actions">
        {ACTIONS.map((a, i) => (
          <li key={a.id}>
            <button
              type="button"
              data-active={i === active}
              disabled={busy}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onRun(a.id)}
            >
              {a.label}
            </button>
          </li>
        ))}
      </ul>
      <p className="ai-write-note">
        {busy
          ? 'Writing…'
          : scope === 'selection'
            ? 'Replaces the selected text. ⌘Z undoes it.'
            : 'Replaces your message above the signature. ⌘Z undoes it.'}
      </p>
      {error && (
        <p className="ai-write-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
