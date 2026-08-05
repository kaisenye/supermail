import { useEffect, useRef, useState } from 'react'

interface Props {
  onSubmit: (url: string) => void
  onCancel: () => void
}

/**
 * Inline replacement for window.prompt(), which Electron does not implement —
 * calling it throws "prompt() is not supported".
 */
export function LinkPrompt({ onSubmit, onCancel }: Props) {
  const [url, setUrl] = useState('https://')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = inputRef.current
    el?.focus()
    // Caret after the scheme so typing continues the URL.
    el?.setSelectionRange(el.value.length, el.value.length)
  }, [])

  return (
    <form
      className="link-prompt"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(url)
      }}
    >
      <input
        ref={inputRef}
        value={url}
        placeholder="https://example.com"
        aria-label="Link URL"
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          // Escape must not bubble to the modal, or it closes the whole thing.
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }
        }}
      />
      <button type="submit">Add</button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  )
}
