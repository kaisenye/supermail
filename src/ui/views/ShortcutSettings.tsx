import { useEffect, useState } from 'react'
import { COMMANDS, keyCaps, type CommandId } from '../commands'
import { onRecordKey } from '../keyLayers'
import { applyKeymap, isRemappable, keymapConflicts, parseKeymap, specFromEvent, type Keymap } from '../keymap'

/** Remap a command's primary key. Reads and writes settings.keymap itself; App reloads it when Settings closes. */
export function ShortcutSettings() {
  const [map, setMap] = useState<Keymap>({})
  const [recording, setRecording] = useState<CommandId | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.getSettings().then((s) => setMap(parseKeymap(s.keymap)))
  }, [])

  const save = (next: Keymap): void => {
    setMap(next)
    void window.api.setSettings({ keymap: JSON.stringify(next) })
  }

  // The recorded key must not also run its current command (⌘K would open the
  // palette over Settings), and Esc must cancel the recording, not close Settings.
  useEffect(() => {
    if (!recording) return
    return onRecordKey((e) => {
      if (e.key === 'Escape') return setRecording(null)
      const spec = specFromEvent(e)
      if (!spec) return
      const next = { ...map, [recording]: spec }
      const clash = keymapConflicts(applyKeymap(COMMANDS, next))
      setRecording(null)
      if (clash.length) return setError(clash[0])
      setError(null)
      save(next)
    })
  }, [recording, map])

  const commands = applyKeymap(COMMANDS, map).filter(isRemappable)

  return (
    <section className="settings-section">
      <h3>Shortcuts</h3>
      {error && <p className="settings-error">{error}</p>}
      <ul className="shortcut-remap">
        {commands.map((c) => (
          <li key={c.id}>
            <span className="shortcut-remap-title">{c.title}</span>
            <span className="shortcut-remap-keys">
              {recording === c.id
                ? 'Press a key… (Esc to cancel)'
                : c.keys[0]
                  ? keyCaps(c.keys[0]).map((k, i) => <kbd key={i}>{k}</kbd>)
                  : '—'}
            </span>
            <button type="button" onClick={() => setRecording(c.id)}>
              Change
            </button>
            {map[c.id] && (
              <button
                type="button"
                onClick={() => {
                  const next = { ...map }
                  delete next[c.id]
                  save(next)
                }}
              >
                Reset
              </button>
            )}
          </li>
        ))}
      </ul>
      {Object.keys(map).length > 0 && (
        <button type="button" onClick={() => save({})}>
          Reset all shortcuts
        </button>
      )}
    </section>
  )
}
