import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react'
import { Bot, Image as ImageIcon, Inbox, Keyboard, Link2, PenLine, Settings as SettingsIcon, TextQuote, Unlink, X } from 'lucide-react'
import { applyLink, captureSelection, cleanPastedHtml, handlePaste } from '../richText'
import { onDialogEscape } from '../keyLayers'
import { LinkPrompt } from './LinkPrompt'
import { TriageSettings } from './TriageSettings'
import { ShortcutSettings } from './ShortcutSettings'
import { SnippetSettings } from './SnippetSettings'
import { AiSettings } from './AiSettings'
import type { Theme } from '../theme'

interface Props {
  email: string | null
  signature: string
  theme: Theme
  onSignature: (html: string) => void
  onTheme: (theme: Theme) => void
  onClose: () => void
}

type Section = 'general' | 'triage' | 'shortcuts' | 'snippets' | 'ai' | 'signature'

const SECTIONS: { id: Section; label: string; icon: typeof Inbox }[] = [
  { id: 'general', label: 'General', icon: SettingsIcon },
  { id: 'triage', label: 'Inbox and triage', icon: Inbox },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
  { id: 'snippets', label: 'Snippets', icon: TextQuote },
  { id: 'signature', label: 'Signature', icon: PenLine },
  { id: 'ai', label: 'AI', icon: Bot }
]

const THEMES: { id: Theme; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
]

export function Settings({
  email,
  signature,
  theme,
  onSignature,
  onTheme,
  onClose
}: Props) {
  const editorRef = useRef<HTMLDivElement>(null)
  const [section, setSection] = useState<Section>('general')
  const [saved, setSaved] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Debounced so a save isn't queued on every keystroke. */
  const autosave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      onSignature(cleanPastedHtml(editorRef.current?.innerHTML ?? ''))
      setSaved(true)
      setTimeout(() => setSaved(false), 1200)
    }, 600)
  }, [onSignature])

  // A pending save must still land if the modal closes first. Deps must stay
  // empty: onSignature changes on every save, and re-running this cleanup
  // would cancel the very timer it is meant to protect.
  const flushRef = useRef<() => void>(() => {})
  flushRef.current = () => {
    if (!saveTimer.current) return
    clearTimeout(saveTimer.current)
    saveTimer.current = null
    onSignature(cleanPastedHtml(editorRef.current?.innerHTML ?? ''))
  }
  useEffect(() => () => flushRef.current(), [])

  const exec = useCallback((cmd: string) => {
    editorRef.current?.focus()
    document.execCommand(cmd, false)
  }, [])

  // Held while the inline prompt is open: focusing the input destroys the
  // editor's selection, so the range has to be captured up front.
  const pendingRange = useRef<Range | null>(null)

  const onLink = useCallback(() => {
    const range = captureSelection(editorRef.current)
    if (!range) {
      setLinkError('Select the text you want to link first')
      return
    }
    setLinkError(null)
    pendingRange.current = range
    setLinking(true)
  }, [])

  const submitLink = useCallback(
    (url: string) => {
      setLinking(false)
      const res = applyLink(editorRef.current, pendingRange.current, url, (html) =>
        onSignature(cleanPastedHtml(html))
      )
      pendingRange.current = null
      setLinkError(
        res === 'ok' ? null : 'Links must start with http://, https:// or mailto:'
      )
    },
    [onSignature]
  )

  const onPaste = useCallback((e: ClipboardEvent<HTMLDivElement>) => {
    // Same guard as compose: the signature ships in every message we send.
    handlePaste(e, editorRef.current, () => {})
  }, [])

  const onLogo = useCallback(async () => {
    const r = await window.api.pickSignatureLogo()
    if (!r.ok) {
      if (r.error !== 'cancelled') setLinkError(r.error)
      return
    }
    setLinkError(null)
    const el = editorRef.current
    el?.focus()
    // Stored as data: so it renders here; flush rewrites it to cid: on send.
    document.execCommand(
      'insertHTML',
      false,
      `<img src="${r.dataUrl}" alt="logo" height="48">`
    )
    if (el) onSignature(cleanPastedHtml(el.innerHTML))
  }, [onSignature])

  useEffect(() => {
    const el = editorRef.current
    if (el && el.innerHTML !== signature) el.innerHTML = signature
    // On open and when the Signature section mounts the editor; writing
    // innerHTML on every keystroke would fight the caret.
  }, [signature, section])

  /** A pending signature save lands before its editor unmounts. */
  const show = (next: Section): void => {
    flushRef.current()
    setSection(next)
  }

  // Document capture, so the shortcut recorder (window capture) gets Esc first.
  useEffect(() => onDialogEscape(onClose), [onClose])

  /** Blur flushes immediately rather than waiting out the debounce. */
  const save = (): void => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    // Sanitise on the way out too: this HTML is embedded in every message, and
    // the editor is not the only way content can reach it.
    onSignature(cleanPastedHtml(editorRef.current?.innerHTML ?? ''))
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  return (
    <div className="settings-page" role="region" aria-label="Settings">
      <nav className="settings-nav" aria-label="Settings sections">
        <h1 className="settings-nav-title">Settings</h1>
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className="settings-nav-item"
            aria-current={section === id}
            onClick={(e) => {
              e.currentTarget.blur()
              show(id)
            }}
          >
            <Icon size={15} strokeWidth={1.75} />
            {label}
          </button>
        ))}
      </nav>

      <div className="settings-content">
        <button type="button" className="settings-close" onClick={onClose} aria-label="Close settings" title="Close (Esc)">
          <X size={16} strokeWidth={2} />
        </button>
        <div className="settings-body" key={section}>
          {section === 'general' && (
            <>
              <h2 className="settings-title">General</h2>
              <section className="settings-section">
                <h3>Account</h3>
                <p className="settings-note">{email ?? 'Not configured'}</p>
              </section>
              <section className="settings-section">
                <h3>Theme</h3>
                <div className="settings-themes">
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      data-on={theme === t.id}
                      onClick={() => onTheme(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}

          {section === 'triage' && (
            <>
              <h2 className="settings-title">Inbox and triage</h2>
              <TriageSettings />
            </>
          )}

          {section === 'shortcuts' && (
            <>
              <h2 className="settings-title">Shortcuts</h2>
              <ShortcutSettings />
            </>
          )}

          {section === 'snippets' && (
            <>
              <h2 className="settings-title">Snippets</h2>
              <SnippetSettings />
            </>
          )}

          {section === 'ai' && (
            <>
              <h2 className="settings-title">AI</h2>
              <AiSettings />
            </>
          )}

          {section === 'signature' && (
          <>
          <h2 className="settings-title">Signature</h2>
          <section className="settings-section">
            <p className="settings-note">
              Appended to new messages and replies. Select text to add a link, or
              insert a logo (PNG/JPG/GIF/WebP, under 512 KB).
            </p>
            <div className="compose-toolbar">
              <button
                type="button"
                className="compose-tool"
                title="Bold"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => exec('bold')}
              >
                B
              </button>
              <button
                type="button"
                className="compose-tool"
                title="Italic"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => exec('italic')}
              >
                I
              </button>
              <button
                type="button"
                className="compose-tool"
                title="Insert link"
                aria-label="Insert link"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onLink}
              >
                <Link2 size={15} strokeWidth={2} />
              </button>
              <button
                type="button"
                className="compose-tool"
                title="Remove link"
                aria-label="Remove link"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => exec('unlink')}
              >
                <Unlink size={15} strokeWidth={2} />
              </button>
              <span className="compose-toolbar-sep" />
              <button
                type="button"
                className="compose-tool"
                title="Insert logo"
                aria-label="Insert logo"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void onLogo()}
              >
                <ImageIcon size={15} strokeWidth={2} />
              </button>
            </div>
            {linking && (
              <LinkPrompt
                onSubmit={submitLink}
                onCancel={() => {
                  setLinking(false)
                  pendingRange.current = null
                }}
              />
            )}
            {linkError && <p className="settings-error">{linkError}</p>}
            <div
              ref={editorRef}
              className="settings-signature"
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              aria-label="Signature"
              onInput={autosave}
              onPaste={onPaste}
              onBlur={save}
            />
            <div className="settings-actions">
              <span className="settings-saved" data-on={saved}>
                Saved
              </span>
            </div>
          </section>
          </>
          )}
        </div>
      </div>
    </div>
  )
}
