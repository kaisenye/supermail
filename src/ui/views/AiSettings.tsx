import { useEffect, useState } from 'react'
import type { AccountSummary, AiFailure, AiFeature, AiProviderId, AiStatus } from '../../../electron/preload'
import { budgetEdit, modelEdit } from '../aiSettingsInput'
import { AiLabelSettings } from './AiLabelSettings'

const PROVIDERS: { id: AiProviderId; label: string; keyHint: string }[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', keyHint: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', keyHint: 'sk-…' }
]

const FEATURES: { id: AiFeature; label: string }[] = [
  { id: 'write', label: 'Write with AI in compose (⌘J)' },
  { id: 'summary', label: 'One-line summary when you open a conversation' },
  { id: 'replies', label: 'Instant Reply: three suggested replies, prepared for new mail that needs one' },
  { id: 'classify', label: 'Sort new mail: Important / Other, a category, and your own labels below' },
  { id: 'ask', label: 'Ask AI from ⌘K (press ⇥), answered from your local mail' }
]

const NAME: Record<AiProviderId, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }

/** The model field's text: empty while the provider's default is in use. */
const shownModel = (s: AiStatus): string =>
  s.models[s.provider] === s.defaultModels[s.provider] ? '' : s.models[s.provider]

/** Settings → AI. Reads and writes through window.api; the key is write-only. */
export function AiSettings({ accounts, activeAccountId }: { accounts: AccountSummary[]; activeAccountId: number | null }) {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [key, setKey] = useState('')
  const [model, setModel] = useState('')
  const [budget, setBudget] = useState('')
  const [error, setError] = useState<string | null>(null)

  const show = (s: AiStatus): void => {
    setStatus(s)
    setModel(shownModel(s))
    setBudget(String(s.budgetUsd))
  }

  useEffect(() => {
    void window.api.aiStatus().then(show)
  }, [])

  const apply = (r: { ok: true; status: AiStatus } | AiFailure): void => {
    if (!r.ok) return setError(r.error)
    setError(null)
    show(r.status)
  }

  if (!status) return null
  const p = status.provider
  const hasKey = status.hasKey[p]

  return (
    <section className="settings-section ai-settings">
      <p className="settings-note">
        Bring your own key. Every feature is off until you switch it on, and nothing is sent anywhere until then.
      </p>

      <div className="settings-themes" role="radiogroup" aria-label="AI provider">
        {PROVIDERS.map((x) => (
          <button
            key={x.id}
            type="button"
            data-on={p === x.id}
            onClick={async () => apply(await window.api.aiSetConfig({ provider: x.id }))}
          >
            {x.label}
          </button>
        ))}
      </div>

      {hasKey ? (
        <div className="settings-split-form">
          <span className="ai-key-saved">{NAME[p]} key saved in your keychain</span>
          <button type="button" onClick={async () => apply(await window.api.aiClearKey(p))}>
            Remove key
          </button>
        </div>
      ) : (
        <form
          className="settings-split-form"
          onSubmit={async (e) => {
            e.preventDefault()
            const r = await window.api.aiSetKey(p, key)
            setKey('')
            apply(r)
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={`${NAME[p]} API key (${PROVIDERS.find((x) => x.id === p)?.keyHint})`}
            aria-label={`${NAME[p]} API key`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button type="submit" disabled={!key.trim()}>
            Save key
          </button>
        </form>
      )}

      <div className="settings-split-form">
        <input
          aria-label="Model"
          placeholder={`Model (default ${status.defaultModels[p]})`}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={async () => {
            const m = modelEdit(model, shownModel(status))
            if (m === null) return setModel(shownModel(status))
            apply(await window.api.aiSetConfig({ model: { provider: p, model: m } }))
          }}
        />
        <input
          aria-label="Daily budget in US dollars"
          type="number"
          min={0}
          max={100}
          step={0.5}
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          onBlur={async () => {
            const b = budgetEdit(budget, status.budgetUsd)
            if (b === null) return setBudget(String(status.budgetUsd))
            apply(await window.api.aiSetConfig({ budgetUsd: b }))
          }}
        />
      </div>
      <p className="settings-note">
        Daily budget ${status.budgetUsd.toFixed(2)} · spent today ${status.spentTodayUsd.toFixed(2)}. When it runs out,
        AI stops until tomorrow; background work stops at 80% of it.
      </p>

      {FEATURES.map((f) => (
        <label key={f.id} className="picker-check" data-disabled={!hasKey}>
          <input
            type="checkbox"
            disabled={!hasKey}
            checked={status.toggles[f.id] && hasKey}
            onChange={async (e) => apply(await window.api.aiSetConfig({ feature: { feature: f.id, on: e.target.checked } }))}
          />
          {f.label}
        </label>
      ))}

      <AiLabelSettings accounts={accounts} activeAccountId={activeAccountId} classifyOn={hasKey && status.toggles.classify} />

      <p className="settings-note ai-privacy">
        Privacy: when a feature runs, the sender, subject and text of the messages it works on are sent from this Mac
        straight to {NAME[p]} with your key. Sovo has no server of its own. Your key is encrypted with the macOS
        keychain and never leaves this Mac except to {NAME[p]}. Ask AI sends the few local messages that match your
        question.
      </p>
      {error && <p className="settings-error">{error}</p>}
    </section>
  )
}
