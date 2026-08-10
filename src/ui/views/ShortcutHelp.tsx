import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

interface Shortcut {
  label: string
  /** Rendered as separate keycaps; `then` marks a chord. */
  keys: string[]
  then?: boolean
  /** Equivalent binding, shown after "or". */
  alt?: string[]
}

interface Group {
  title: string
  items: Shortcut[]
}

/** Mirrors the bindings in App.tsx — update both together. */
const GROUPS: Group[] = [
  {
    title: 'General',
    items: [
      { label: 'Search and command menu', keys: ['⌘', 'K'], alt: ['/'] },
      { label: 'Compose', keys: ['c'] },
      { label: 'Settings', keys: [','] },
      { label: 'Keyboard shortcuts', keys: ['⌘', '.'], alt: ['?'] },
      { label: 'Close · clear selection · go back', keys: ['Esc'] }
    ]
  },
  {
    title: 'Navigation',
    items: [
      { label: 'Move down', keys: ['j'] },
      { label: 'Move up', keys: ['k'] },
      { label: 'Open message', keys: ['Enter'] },
      { label: 'Go to inbox', keys: ['g', 'i'], then: true },
      { label: 'Go to sent', keys: ['g', 's'], then: true },
      { label: 'Go to drafts', keys: ['g', 'd'], then: true },
      { label: 'Go to trash', keys: ['g', 't'], then: true },
      { label: 'Go to junk', keys: ['g', 'j'], then: true }
    ]
  },
  {
    title: 'Message',
    items: [
      { label: 'Star', keys: ['s'] },
      { label: 'Toggle read / unread', keys: ['u'] },
      { label: 'Trash', keys: ['⌫'] },
      { label: 'Select', keys: ['x'] }
    ]
  },
  {
    title: 'In a thread',
    items: [
      { label: 'Reply', keys: ['r'] },
      { label: 'Reply all', keys: ['⇧', 'R'] },
      { label: 'Forward', keys: ['f'] }
    ]
  },
  {
    title: 'Compose',
    items: [
      { label: 'Send', keys: ['⌘', '↵'] },
      { label: 'Bold', keys: ['⌘', 'B'] },
      { label: 'Italic', keys: ['⌘', 'I'] },
      { label: 'Underline', keys: ['⌘', 'U'] }
    ]
  }
]

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="shortcut-backdrop" onClick={onClose}>
      <div
        className="shortcut-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="shortcut-head">
          <h2>Keyboard shortcuts</h2>
          <button className="shortcut-close" onClick={onClose} aria-label="Close">
            <X size={14} strokeWidth={2} />
          </button>
        </header>

        <div className="shortcut-scroll">
          {GROUPS.map((g) => (
            <section key={g.title} className="shortcut-group">
              <h3>{g.title}</h3>
              {g.items.map((s) => (
                <div key={`${g.title}-${s.label}-${s.keys.join()}`} className="shortcut-row">
                  <span className="shortcut-label">{s.label}</span>
                  <span className="shortcut-keys">
                    {s.keys.map((k, i) => (
                      <span key={`${k}-${i}`}>
                        {s.then && i > 0 && <em>then</em>}
                        <kbd>{k}</kbd>
                      </span>
                    ))}
                    {s.alt && (
                      <span>
                        <em>or</em>
                        {s.alt.map((k, i) => (
                          <kbd key={`${k}-${i}`}>{k}</kbd>
                        ))}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
