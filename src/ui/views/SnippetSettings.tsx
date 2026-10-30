import { useEffect, useState } from 'react'
import type { Snippet } from '../../../electron/preload'

const BLANK = { id: undefined as number | undefined, name: '', shortcut: '', body: '' }

/** Snippet editor. Variables: {first_name} {last_name} {name} {email} {my_name} {my_first_name} {my_email} {date} {day}. */
export function SnippetSettings() {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [draft, setDraft] = useState(BLANK)
  const [error, setError] = useState<string | null>(null)

  const reload = (): void => void window.api.listSnippets().then(setSnippets)
  useEffect(reload, [])

  const save = async (): Promise<void> => {
    const r = await window.api.saveSnippet({
      id: draft.id,
      name: draft.name,
      shortcut: draft.shortcut || null,
      body: draft.body
    })
    if (!r.ok) return setError(r.error)
    setError(null)
    setDraft(BLANK)
    reload()
  }

  return (
    <section className="settings-section">
      <h3>Snippets</h3>
      <p className="settings-note">
        Type <code>;shortcut</code> then ⇥ in a message, or press ⌘; to pick one. Variables: {'{first_name}'},{' '}
        {'{last_name}'}, {'{name}'}, {'{email}'}, {'{my_name}'}, {'{my_first_name}'}, {'{my_email}'}, {'{date}'},{' '}
        {'{day}'}.
      </p>
      <ul className="snippet-list">
        {snippets.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => setDraft({ id: s.id, name: s.name, shortcut: s.shortcut ?? '', body: s.body })}
            >
              {s.name}
              {s.shortcut && <span className="snippet-key">;{s.shortcut}</span>}
            </button>
            <button
              type="button"
              aria-label={`Delete ${s.name}`}
              onClick={async () => {
                await window.api.deleteSnippet(s.id)
                if (draft.id === s.id) setDraft(BLANK)
                reload()
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="snippet-form">
        <input placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input
          placeholder="Shortcut (optional)"
          value={draft.shortcut}
          onChange={(e) => setDraft({ ...draft, shortcut: e.target.value })}
        />
        <textarea
          placeholder="Hi {first_name}, …"
          rows={4}
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        />
        {error && <p className="settings-error">{error}</p>}
        <div>
          <button type="button" onClick={() => void save()}>
            {draft.id ? 'Save snippet' : 'Add snippet'}
          </button>
          {draft.id && (
            <button type="button" onClick={() => setDraft(BLANK)}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
