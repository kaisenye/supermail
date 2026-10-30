import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { shortcutGroups, type Command } from '../commands'

/** Built from the command registry (with the user's keymap), so it cannot drift from the real bindings. */
export function ShortcutHelp({ onClose, commands }: { onClose: () => void; commands?: Command[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const groups = shortcutGroups(commands)

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
          {groups.map((g) => (
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
