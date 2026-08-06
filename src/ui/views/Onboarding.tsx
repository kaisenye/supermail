import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, Loader2, LockKeyhole } from 'lucide-react'

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
  const emailRef = useRef<HTMLInputElement>(null)

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
      setError(res.error ?? 'Could not connect.')
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

  if (stage === 'welcome') {
    return (
      <div className="onboard">
        <div className="onboard-panel onboard-welcome">
          <div className="onboard-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h1>Supermail</h1>
          <p className="onboard-lede">
            Your mail, stored locally and searchable instantly. Connect an IMAP account to begin.
          </p>
          <button className="onboard-primary" onClick={() => setStage('connect')} autoFocus>
            Connect an account
            <ArrowRight size={14} strokeWidth={2} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="onboard">
      <div className="onboard-panel">
        <header className="onboard-head">
          <h2>{mode === 'add' ? 'Add an account' : 'Connect your account'}</h2>
          {preset && preset.id !== 'generic' && (
            <span className="onboard-provider">{preset.label}</span>
          )}
        </header>

        <form
          className="onboard-form"
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
              placeholder="Shown as the sender on mail you send"
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
            </span>
          </button>

          {advanced && (
            <div className="onboard-advanced">
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
          )}

          {error && (
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
            <button type="submit" className="onboard-primary" disabled={!valid || busy}>
              {busy ? (
                <>
                  <Loader2 size={14} strokeWidth={2} className="onboard-spin" />
                  Verifying…
                </>
              ) : stage === 'syncing' ? (
                <>
                  <Check size={14} strokeWidth={2} />
                  Connected
                </>
              ) : (
                <>
                  Connect
                  <ArrowRight size={14} strokeWidth={2} />
                </>
              )}
            </button>
          </div>

          <p className="onboard-privacy">
            <LockKeyhole size={11} strokeWidth={2} />
            Your password is stored in the macOS Keychain and never leaves this machine.
          </p>
          {stageField === 'imap' && !advanced && (
            <p className="onboard-hint">Check the server settings above.</p>
          )}
        </form>
      </div>
    </div>
  )
}
