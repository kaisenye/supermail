import { useEffect, useState } from 'react'
import type { Split } from '../../../electron/preload'
import { createArchiveFolder } from '../folders'

const UNDO_CHOICES = ['3', '5', '10', '20']

/**
 * Triage preferences. Reads and writes settings itself so Settings.tsx does not
 * have to thread more props through App.
 */
export function TriageSettings() {
  const [undoSecs, setUndoSecs] = useState('3')
  const [archive, setArchive] = useState<{
    hasArchive: boolean
    canCreate: boolean
    reason?: string
    host: string
  } | null>(null)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [splits, setSplits] = useState<Split[]>([])
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [splitError, setSplitError] = useState<string | null>(null)
  const [cancelDefault, setCancelDefault] = useState(false)
  const [fullHistory, setFullHistory] = useState(true)

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      if (UNDO_CHOICES.includes(s.undo_seconds)) setUndoSecs(s.undo_seconds)
      setCancelDefault(s.cancel_on_reply_default === '1')
      setFullHistory(s.full_history !== '0')
    })
    void window.api.archiveStatus().then((r) => {
      if (r.ok)
        setArchive({
          hasArchive: r.hasArchive,
          canCreate: r.canCreate,
          reason: r.reason,
          host: r.host
        })
    })
    void window.api.listSplits().then(setSplits)
  }, [])

  const pickUndo = (v: string): void => {
    setUndoSecs(v)
    void window.api.setSettings({ undo_seconds: v })
  }

  // Only ever runs from the confirm step: nothing is created on the server unasked.
  const createArchive = async (): Promise<void> => {
    setConfirming(false)
    // Also reloads the store's folders, so the sidebar and `g e` see Archive now.
    const r = await createArchiveFolder()
    if (!r.ok) return setArchiveError(r.error)
    setArchiveError(null)
    setArchive((a) => (a ? { ...a, hasArchive: true } : a))
  }

  const addSplit = async (): Promise<void> => {
    const r = await window.api.saveSplit({ name, query })
    if (!r.ok) return setSplitError(r.error)
    setSplitError(null)
    setName('')
    setQuery('')
    setSplits(await window.api.listSplits())
  }

  return (
    <>
      <section className="settings-section">
        <h3>Undo window</h3>
        <p className="settings-note">
          How long sends and moves wait before they reach the server. Press z or use the toast to
          take them back.
        </p>
        <div className="settings-themes">
          {UNDO_CHOICES.map((v) => (
            <button key={v} type="button" data-on={undoSecs === v} onClick={() => pickUndo(v)}>
              {v}s
            </button>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <h3>Done folder</h3>
        {archive?.hasArchive ? (
          <p className="settings-note">Done (e) moves conversations to your archive folder.</p>
        ) : archive && !archive.canCreate ? (
          // Gmail: Done goes to All Mail; creating an "Archive" label would not help.
          <p className="settings-note">{archive.reason}</p>
        ) : confirming ? (
          <>
            <p className="settings-note">
              This creates a folder named “Archive” on {archive?.host}. Nothing else changes.
            </p>
            <div className="settings-themes">
              <button type="button" onClick={() => void createArchive()}>
                Create it
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="settings-note">
              This mailbox has no archive folder, so Done (e) has nowhere to put mail yet.
            </p>
            <div className="settings-themes">
              <button type="button" onClick={() => setConfirming(true)}>
                Create an Archive folder…
              </button>
            </div>
          </>
        )}
        {archiveError && <p className="settings-error">{archiveError}</p>}
      </section>
      <section className="settings-section">
        <h3>Splits</h3>
        <p className="settings-note">
          Tabs across the Inbox, cycled with Tab. A split is a search: from:, to:, subject:,
          is:unread, is:needs-reply, is:waiting, is:vip, is:bulk.
        </p>
        <ul className="settings-splits">
          {splits.map((s) => (
            <li key={s.id}>
              <span>{s.name}</span>
              <code>{s.query || '(everything)'}</code>
              {!s.builtin && (
                <button
                  type="button"
                  onClick={async () => {
                    await window.api.deleteSplit(s.id)
                    setSplits(await window.api.listSplits())
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="settings-split-form">
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            placeholder="from:github.com"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" onClick={() => void addSplit()}>
            Add
          </button>
        </div>
        {splitError && <p className="settings-error">{splitError}</p>}
      </section>
      <section className="settings-section">
        <h3>Scheduled sends</h3>
        <label className="picker-check">
          <input
            type="checkbox"
            checked={cancelDefault}
            onChange={(e) => {
              setCancelDefault(e.target.checked)
              void window.api.setSettings({ cancel_on_reply_default: e.target.checked ? '1' : '0' })
            }}
          />
          Cancel a scheduled reply when someone replies first
        </label>
      </section>
      <section className="settings-section">
        <h3>Offline history</h3>
        <label className="picker-check">
          <input
            type="checkbox"
            checked={fullHistory}
            onChange={(e) => {
              setFullHistory(e.target.checked)
              void window.api.setSettings({ full_history: e.target.checked ? '1' : '0' })
            }}
          />
          Download the whole mailbox in the background (headers only)
        </label>
      </section>
    </>
  )
}
