import { useCallback, useEffect, useRef, useState } from 'react'

interface Contact {
  address: string
  name: string | null
}

interface Props {
  label: string
  value: string
  onChange: (value: string) => void
  autoFocus?: boolean
}

/** Only the address being typed is completed; earlier ones are left alone. */
function splitTail(value: string): { head: string; tail: string } {
  const i = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'))
  return i === -1
    ? { head: '', tail: value }
    : { head: value.slice(0, i + 1), tail: value.slice(i + 1) }
}

function formatContact(c: Contact): string {
  return c.name ? `${c.name} <${c.address}>` : c.address
}

export function RecipientField({ label, value, onChange, autoFocus }: Props) {
  const [matches, setMatches] = useState<Contact[]>([])
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    setMatches([])
    setActive(0)
  }, [])

  // Debounced: a query per keystroke would thrash the main process.
  useEffect(() => {
    if (!open) return
    const tail = splitTail(value).tail.trim()
    // A completed "Name <addr>" needs no further lookup.
    if (tail.length < 2 || tail.endsWith('>')) {
      setMatches([])
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      void window.api.searchContacts(tail, 6).then((r) => {
        if (cancelled) return
        setMatches(r)
        setActive(0)
      })
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [value, open])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [close])

  const choose = useCallback(
    (c: Contact) => {
      const { head } = splitTail(value)
      onChange(`${head}${head ? ' ' : ''}${formatContact(c)}, `)
      close()
    },
    [value, onChange, close]
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!matches.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % matches.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + matches.length) % matches.length)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      // Only claim the key when a suggestion is genuinely highlighted, so
      // Enter/Tab keep working normally in an empty or completed field.
      e.preventDefault()
      choose(matches[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  return (
    <div className="compose-field" ref={boxRef}>
      <span>{label}</span>
      <div className="recipient-wrap">
        <input
          value={value}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setOpen(true)
            onChange(e.target.value)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {open && matches.length > 0 && (
          <ul className="recipient-menu" role="listbox">
            {matches.map((c, i) => (
              <li key={c.address}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active}
                  onMouseEnter={() => setActive(i)}
                  // mousedown would blur the input before the click lands.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    choose(c)
                  }}
                >
                  {c.name && <span className="recipient-name">{c.name}</span>}
                  <span className="recipient-addr">{c.address}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
