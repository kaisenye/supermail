import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, ChevronDown, Loader2, LockKeyhole } from 'lucide-react'
import { BrandMark } from './BrandMark'
import { onDialogEscape } from '../keyLayers'

interface Preset {
  id: string
  label: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  smtpSavesSent: boolean
  passwordHint?: string
}

type Stage = 'welcome' | 'connect' | 'syncing'

interface Props {
  /** Adding a second account skips the welcome copy and can be cancelled. */
  mode?: 'first-run' | 'add'
  onCancel?: () => void
  onConnected: () => void
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** How long the welcome takes to step aside before the form comes in. */
const HANDOFF_MS = 220

/** Stagger index for the entrance animation (`.onboard-in`). */
const step = (i: number): React.CSSProperties => ({ '--i': i }) as React.CSSProperties

export function Onboarding({ mode = 'first-run', onCancel, onConnected }: Props) {
  const [stage, setStage] = useState<Stage>(mode === 'add' ? 'connect' : 'welcome')
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [name, setName] = useState('')
  const [preset, setPreset] = useState<Preset | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [hosts, setHosts] = useState({ imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465 })
  // Untouched host fields track the detected preset; edited ones stay put.
  const [hostsDirty, setHostsDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stageField, setStageField] = useState<'imap' | 'smtp' | null>(null)
  const [oauthBusy, setOauthBusy] = useState<'google' | 'microsoft' | null>(null)
  const [leaving, setLeaving] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)

  // Adding an account sits over the app; Esc puts it away.
  useEffect(() => (mode === 'add' && onCancel ? onDialogEscape(onCancel) : undefined), [mode, onCancel])

  // The welcome steps aside before the form comes in, rather than cutting.
  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(() => setStage('connect'), HANDOFF_MS)
    return () => clearTimeout(t)
  }, [leaving])

  useEffect(() => {
    if (stage === 'connect') emailRef.current?.focus()
  }, [stage])

  // Detect the provider as the address is typed, so hosts are filled before
  // the user ever thinks about them.
  useEffect(() => {
    if (!email.includes('@')) return
    let cancelled = false
    void window.api.accountPreset(email).then((p: Preset) => {
      if (cancelled) return
      setPreset(p)
      if (!hostsDirty) {
        setHosts({
          imapHost: p.imapHost,
          imapPort: p.imapPort,
          smtpHost: p.smtpHost,
          smtpPort: p.smtpPort
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [email, hostsDirty])

  const valid = EMAIL_RE.test(email) && pass.length > 0 && hosts.imapHost && hosts.smtpHost

  const connect = useCallback(async () => {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    setStageField(null)
    const res = await window.api.accountAdd({
      email: email.trim(),
      pass,
      name: name.trim() || null,
      ...hosts,
      smtpSavesSent: preset?.smtpSavesSent
    })
    if (!res.ok) {
      setError(res.error ?? "Couldn't connect. Check the address and password.")
      // Point the user at the leg that actually failed.
      setStageField(/port|server|host|timed out|refused/i.test(res.error ?? '') ? 'imap' : null)
      setBusy(false)
      // Advanced holds the fields most likely at fault for a host error.
      if (/server|port|host/i.test(res.error ?? '')) setAdvanced(true)
      return
    }
    setBusy(false)
    setStage('syncing')
    onConnected()
  }, [valid, busy, email, pass, name, hosts, preset, onConnected])

  const signIn = useCallback(
    async (provider: 'google' | 'microsoft') => {
      if (oauthBusy) return
      setOauthBusy(provider)
      setError(null)
      const res = await window.api.accountOAuth(provider)
      setOauthBusy(null)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setStage('syncing')
      onConnected()
    },
    [oauthBusy, onConnected]
  )

  if (stage === 'welcome') {
    return (
      <div className="onboard">
        <div className="onboard-panel onboard-welcome" data-leaving={leaving}>
          <BrandMark className="onboard-mark" size={56} animate />
          <h1 className="onboard-in" style={step(4)}>
            Sovo
          </h1>
          <p className="onboard-lede onboard-in" style={step(5)}>
            Your inbox, kept on your machine. Opens instantly, finds anything, works offline.
          </p>
          <button
            className="onboard-primary onboard-in"
            style={step(6)}
            onClick={() => setLeaving(true)}
            disabled={leaving}
            autoFocus
          >
            Bring your inbox
            <ArrowRight size={14} strokeWidth={2} className="onboard-arrow" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="onboard">
      <div className="onboard-panel">
        <header className="onboard-head onboard-in" style={step(0)}>
          <h2>{mode === 'add' ? 'Add another inbox' : 'Where does your mail live?'}</h2>
          {preset && preset.id !== 'generic' && (
            <span className="onboard-provider">{preset.label}</span>
          )}
        </header>

        <div className="onboard-providers onboard-in" style={step(1)}>
          <button
            type="button"
            className="onboard-provider-btn"
            disabled={!!oauthBusy || busy}
            onClick={() => void signIn('google')}
          >
            {oauthBusy === 'google' ? (
              <Loader2 size={14} strokeWidth={2} className="onboard-spin" />
            ) : null}
            Continue with Google
          </button>
          <button
            type="button"
            className="onboard-provider-btn"
            disabled={!!oauthBusy || busy}
            onClick={() => void signIn('microsoft')}
          >
            {oauthBusy === 'microsoft' ? (
              <Loader2 size={14} strokeWidth={2} className="onboard-spin" />
            ) : null}
            Continue with Microsoft
          </button>
          {oauthBusy && <p className="onboard-note">Over to your browser. Come back once you're signed in.</p>}
          {error && !email && (
            <p className="onboard-error" role="alert">
              {error}
            </p>
          )}
          <div className="onboard-divider">
            <span>or any other mailbox</span>
          </div>
        </div>

        <form
          className="onboard-form onboard-in"
          style={step(2)}
          onSubmit={(e) => {
            e.preventDefault()
            void connect()
          }}
        >
          <label className="onboard-field">
            <span>Email address</span>
            <input
              ref={emailRef}
              type="email"
              value={email}
              autoComplete="username"
              spellCheck={false}
              placeholder="you@company.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          <label className="onboard-field">
            <span>Password</span>
            <input
              type="password"
              value={pass}
              autoComplete="current-password"
              placeholder="App-specific password"
              onChange={(e) => setPass(e.target.value)}
            />
          </label>

          {preset?.passwordHint && <p className="onboard-hint">{preset.passwordHint}</p>}

          <label className="onboard-field">
            <span>
              Display name <em>optional</em>
            </span>
            <input
              type="text"
              value={name}
              spellCheck={false}
              placeholder="How you show up in their inbox"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <button
            type="button"
            className="onboard-disclose"
            aria-expanded={advanced}
            onClick={() => setAdvanced((v) => !v)}
          >
            Server settings
            <span className="onboard-disclose-note">
              {advanced ? 'hide' : `${hosts.imapHost || 'auto'} · ${hosts.smtpHost || 'auto'}`}
              <ChevronDown size={13} strokeWidth={2} className="onboard-chevron" />
            </span>
          </button>

          {/* Always rendered so it can slide open; inert while closed. */}
          <div className="onboard-advanced" data-open={advanced} inert={!advanced}>
            <div className="onboard-advanced-inner">
              <div className="onboard-row">
                <label className="onboard-field">
                  <span>IMAP server</span>
                  <input
                    value={hosts.imapHost}
                    spellCheck={false}
                    onChange={(e) => {
                      setHostsDirty(true)
                      setHosts({ ...hosts, imapHost: e.target.value })
                    }}
                  />
                </label>
                <label className="onboard-field onboard-port">
                  <span>Port</span>
                  <input
                    value={hosts.imapPort}
                    inputMode="numeric"
                    onChange={(e) => {
                      setHostsDirty(true)
                      setHosts({ ...hosts, imapPort: Number(e.target.value) || 0 })
                    }}
                  />
                </label>
              </div>
              <div className="onboard-row">
                <label className="onboard-field">
                  <span>SMTP server</span>
                  <input
                    value={hosts.smtpHost}
                    spellCheck={false}
                    onChange={(e) => {
                      setHostsDirty(true)
                      setHosts({ ...hosts, smtpHost: e.target.value })
                    }}
                  />
                </label>
                <label className="onboard-field onboard-port">
                  <span>Port</span>
                  <input
                    value={hosts.smtpPort}
                    inputMode="numeric"
                    onChange={(e) => {
                      setHostsDirty(true)
                      setHosts({ ...hosts, smtpPort: Number(e.target.value) || 0 })
                    }}
                  />
                </label>
              </div>
            </div>
          </div>

          {error && email && (
            <p className="onboard-error" role="alert">
              {error}
            </p>
          )}

          <div className="onboard-actions">
            {mode === 'add' && (
              <button type="button" className="onboard-secondary" onClick={onCancel}>
                Cancel
              </button>
            )}
            <button
              type="submit"
              className="onboard-primary"
              data-done={stage === 'syncing'}
              disabled={!valid || busy || stage === 'syncing'}
            >
              {busy ? (
                <>
                  <Loader2 size={14} strokeWidth={2} className="onboard-spin" />
                  Knocking on the server…
                </>
              ) : stage === 'syncing' ? (
                <>
                  <Check size={14} strokeWidth={2.5} className="onboard-check" />
                  You're in
                </>
              ) : (
                <>
                  Connect
                  <ArrowRight size={14} strokeWidth={2} className="onboard-arrow" />
                </>
              )}
            </button>
          </div>

          <p className="onboard-privacy">
            <LockKeyhole size={11} strokeWidth={2} />
            Password stays in your Keychain. Only your mail server sees it.
          </p>
          {stageField === 'imap' && !advanced && (
            <p className="onboard-hint">The server didn't answer. Double-check the settings above.</p>
          )}
        </form>
      </div>
    </div>
  )
}
