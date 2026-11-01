import { useEffect, useState } from 'react'
import type { AccountSummary, AiLabel } from '../../../electron/preload'
import { AI_CATEGORY_NAMES } from '../labelChips'

/** The classifier's fixed categories, as the note names them. */
const FIXED = `${AI_CATEGORY_NAMES.slice(0, -1).join(', ')} and ${AI_CATEGORY_NAMES.at(-1)}`

/** The Inbox split a label can add (Tab cycles splits); deleting the label removes it again. */
const splitQuery = (name: string): string => `ai:"${name}"`

interface Props {
  accounts: AccountSummary[]
  activeAccountId: number | null
  /** The classifier is on (with a key): only then does anything get labelled. */
  classifyOn: boolean
}

/**
 * Settings → AI → Labels. The classifier always sorts into the fixed
 * categories; an inbox's own labels are only applied once the user adds them
 * here. Saving one sorts that inbox's last 14 days in the background.
 */
export function AiLabelSettings({ accounts, activeAccountId, classifyOn }: Props) {
  const [accountId, setAccountId] = useState<number | null>(
    accounts.some((a) => a.accountId === activeAccountId) ? activeAccountId : (accounts[0]?.accountId ?? null)
  )
  const [labels, setLabels] = useState<AiLabel[]>([])
  const [editing, setEditing] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [asTab, setAsTab] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    if (accountId == null) return
    let live = true
    void window.api.aiLabels(accountId).then((l) => live && setLabels(l))
    return () => {
      live = false
    }
  }, [accountId])

  const reset = (): void => {
    setEditing(null)
    setName('')
    setDescription('')
    setAsTab(true)
    setError(null)
  }

  const pick = (id: number): void => {
    setAccountId(id)
    setSaved(null)
    reset()
  }

  const save = async (): Promise<void> => {
    if (accountId == null) return
    const before = labels.find((l) => l.id === editing)
    const r = await window.api.aiSaveLabel({ id: editing ?? undefined, accountId, name, description })
    if (!r.ok) return setError(r.error)
    const splits = await window.api.listSplits()
    // A renamed label takes its split along.
    const old = before && splits.find((s) => !s.builtin && s.query === splitQuery(before.name))
    if (old && before.name !== r.label.name) await window.api.saveSplit({ id: old.id, name: r.label.name, query: splitQuery(r.label.name) })
    else if (!before && asTab && !splits.some((s) => s.query === splitQuery(r.label.name)))
      await window.api.saveSplit({ name: r.label.name, query: splitQuery(r.label.name) })
    setLabels(await window.api.aiLabels(accountId))
    setSaved(classifyOn ? `Sorting the last 14 days into ${r.label.name}…` : null)
    reset()
  }

  const remove = async (l: AiLabel): Promise<void> => {
    await window.api.aiDeleteLabel(l.id)
    // The split goes only when no other inbox still has a label by that name.
    const others = await Promise.all(
      accounts.filter((a) => a.accountId !== l.account_id).map((a) => window.api.aiLabels(a.accountId))
    )
    if (!others.flat().some((o) => o.name.toLowerCase() === l.name.toLowerCase())) {
      const tab = (await window.api.listSplits()).find((s) => !s.builtin && s.query === splitQuery(l.name))
      if (tab) await window.api.deleteSplit(tab.id)
    }
    if (editing === l.id) reset()
    setLabels((ls) => ls.filter((x) => x.id !== l.id))
  }

  return (
    <div className="ai-labels">
      <h3>Labels</h3>
      <p className="settings-note">
        New mail is sorted into {FIXED}. Add your own labels and Sovo files this inbox’s mail under them too; one message
        can get several. {classifyOn ? '' : 'Turn on Sort new mail above to apply them.'}
      </p>
      {accounts.length > 1 && (
        <div className="sig-inboxes" role="tablist" aria-label="Inbox">
          {accounts.map((a) => (
            <button
              key={a.accountId}
              type="button"
              role="tab"
              aria-selected={accountId === a.accountId}
              onClick={() => pick(a.accountId)}
            >
              {a.email}
            </button>
          ))}
        </div>
      )}
      {labels.length > 0 && (
        <ul className="settings-splits ai-label-list">
          {labels.map((l) => (
            <li key={l.id} data-editing={editing === l.id}>
              <span className="row-label">{l.name}</span>
              <span className="ai-label-desc">{l.description}</span>
              <button
                type="button"
                onClick={() => {
                  setEditing(l.id)
                  setName(l.name)
                  setDescription(l.description)
                  setError(null)
                }}
              >
                Edit
              </button>
              <button type="button" onClick={() => void remove(l)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="ai-label-form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <input
          aria-label="Label name"
          placeholder="Name, e.g. Customers"
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          aria-label="What mail belongs under this label"
          placeholder="What belongs here, e.g. Mail from customers about orders, quotes or deliveries"
          maxLength={500}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="ai-label-actions">
          {editing == null && (
            <label className="picker-check">
              <input type="checkbox" checked={asTab} onChange={(e) => setAsTab(e.target.checked)} />
              Add as an Inbox split (⇥ cycles splits)
            </label>
          )}
          {editing != null && (
            <button type="button" onClick={reset}>
              Cancel
            </button>
          )}
          <button type="submit" disabled={!name.trim() || !description.trim()}>
            {editing == null ? 'Add label' : 'Save label'}
          </button>
        </div>
      </form>
      {error && <p className="settings-error">{error}</p>}
      {saved && !error && <p className="settings-note">{saved}</p>}
    </div>
  )
}
