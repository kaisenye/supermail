import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react'
import { ArrowLeft, Bold, Bot, Image as ImageIcon, Italic, Inbox, Keyboard, Link2, Monitor, Moon, PenLine, Search, Settings as SettingsIcon, Sun, TextQuote, Unlink } from 'lucide-react'
import { applyLink, captureSelection, cleanPastedHtml, handlePaste } from '../richText'
import { onDialogEscape } from '../keyLayers'
import { useActiveFormats } from '../hooks/useActiveFormats'
import { LinkPrompt } from './LinkPrompt'
import { TriageSettings } from './TriageSettings'
import { ShortcutSettings } from './ShortcutSettings'
import { SnippetSettings } from './SnippetSettings'
import { AiSettings } from './AiSettings'
import type { Theme } from '../theme'
import type { AccountSummary } from '../../../electron/preload'

interface Props {
  email: string | null
  accounts: AccountSummary[]
  onAddAccount: () => void
  onShortcuts: () => void
  /** The shortcut sheet is open on top: its Esc comes first. */
  shortcutsOpen?: boolean
  signature: string
  theme: Theme
  onSignature: (html: string) => void
  onTheme: (theme: Theme) => void
  onClose: () => void
}

type Section = 'general' | 'triage' | 'shortcuts' | 'snippets' | 'ai' | 'signature'

interface SectionInfo {
  id: Section
  label: string
  /** The line under the page title; also searched. */
  blurb: string
  /** Extra words the settings search matches. */
  keywords: string
  icon: typeof Inbox
}

/** Grouped like Scape's settings sidebar. */
const GROUPS: { title: string; sections: SectionInfo[] }[] = [
  {
    title: 'Preferences',
    sections: [
      { id: 'general', label: 'General', blurb: 'Inboxes, appearance and shortcuts.', keywords: 'account inbox theme dark light appearance', icon: SettingsIcon },
      { id: 'shortcuts', label: 'Shortcuts', blurb: 'Change the key for any command.', keywords: 'keys keyboard remap hotkeys', icon: Keyboard },
      { id: 'snippets', label: 'Snippets', blurb: 'Reusable text you insert with ; in compose.', keywords: 'templates text', icon: TextQuote },
      { id: 'ai', label: 'AI', blurb: 'Your own Anthropic or OpenAI key, budget and features.', keywords: 'anthropic openai claude key budget summary reply classify ask', icon: Bot }
    ]
  },
  {
    title: 'Email',
    sections: [
      { id: 'triage', label: 'Inbox and triage', blurb: 'Undo, Done folder, splits, scheduled sends and history.', keywords: 'undo archive done splits scheduled history offline', icon: Inbox },
      { id: 'signature', label: 'Signature', blurb: 'Added to new messages and replies.', keywords: 'logo link', icon: PenLine }
    ]
  }
]

const SECTIONS = GROUPS.flatMap((g) => g.sections)

const THEMES: { id: Theme; label: string; icon: typeof Sun }[] = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon }
]

export function Settings({
  email,
  accounts,
  onAddAccount,
  onShortcuts,
  shortcutsOpen = false,
  signature,
  theme,
  onSignature,
  onTheme,
  onClose
}: Props) {
  const editorRef = useRef<HTMLDivElement>(null)
  const [section, setSection] = useState<Section>('general')
  const [query, setQuery] = useState('')
  const [saved, setSaved] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Rich editing, or the raw HTML (for a signature pasted from elsewhere). */
  const [sigMode, setSigMode] = useState<'rich' | 'html'>('rich')
  const [htmlText, setHtmlText] = useState(signature)
  /**
   * The latest signature, whichever mode wrote it. Saves read this, never the
   * editor: React clears the editor's ref before unmount cleanup runs, so a
   * flush on close would otherwise save an empty signature.
   */
  const latest = useRef(signature)
  const [activeFormats, refreshFormats] = useActiveFormats(editorRef)

  /** Debounced so a save isn't queued on every keystroke. */
  const autosave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      onSignature(cleanPastedHtml(latest.current))
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
    onSignature(cleanPastedHtml(latest.current))
  }
  useEffect(() => () => flushRef.current(), [])

  /** The rich editor changed: remember its HTML and queue a save. */
  const onRichInput = useCallback(() => {
    latest.current = editorRef.current?.innerHTML ?? latest.current
    autosave()
  }, [autosave])

  const exec = useCallback((cmd: string) => {
    editorRef.current?.focus()
    document.execCommand(cmd, false)
    onRichInput()
    refreshFormats()
  }, [onRichInput, refreshFormats])

  const switchMode = (next: 'rich' | 'html'): void => {
    if (next === sigMode) return
    if (next === 'html') {
      setHtmlText(latest.current)
    } else {
      // Back to rich: what was typed as HTML is cleaned the same way a paste is.
      const clean = cleanPastedHtml(htmlText)
      latest.current = clean
      onSignature(clean)
    }
    setSigMode(next)
  }

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
      const res = applyLink(editorRef.current, pendingRange.current, url, (html) => {
        latest.current = html
        onSignature(cleanPastedHtml(html))
      })
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
    if (el) {
      latest.current = el.innerHTML
      onSignature(cleanPastedHtml(el.innerHTML))
    }
  }, [onSignature])

  useEffect(() => {
    const el = editorRef.current
    if (el && el.innerHTML !== signature) el.innerHTML = signature
    // On open, when the Signature section mounts the editor, and when HTML
    // mode hands back to rich; writing innerHTML on every keystroke would
    // fight the caret.
  }, [signature, section, sigMode])

  /** A pending signature save lands before its editor unmounts. */
  const show = (next: Section): void => {
    flushRef.current()
    setSection(next)
  }

  // Document capture, so the shortcut recorder (window capture) gets Esc first.
  useEffect(() => (shortcutsOpen ? undefined : onDialogEscape(onClose)), [onClose, shortcutsOpen])

  /** Blur flushes immediately rather than waiting out the debounce. */
  const save = (): void => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    // Sanitise on the way out too: this HTML is embedded in every message, and
    // the editor is not the only way content can reach it.
    onSignature(cleanPastedHtml(latest.current))
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  const current = SECTIONS.find((x) => x.id === section) ?? SECTIONS[0]
  const q = query.trim().toLowerCase()
  const matches = (x: SectionInfo): boolean =>
    !q || `${x.label} ${x.blurb} ${x.keywords}`.toLowerCase().includes(q)

  return (
    <>
      {/* Takes the app sidebar's place while settings is open (Scape). */}
      <nav className="settings-nav" aria-label="Settings sections">
        <button
          type="button"
          className="settings-back"
          onClick={(e) => {
            e.currentTarget.blur()
            onClose()
          }}
        >
          <ArrowLeft size={16} strokeWidth={1.75} />
          Back to app
        </button>
        <label className="settings-search">
          <Search size={14} strokeWidth={1.75} />
          <input
            placeholder="Search settings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const first = SECTIONS.find(matches)
              if (first) show(first.id)
            }}
          />
        </label>
        {GROUPS.map((g) => {
          const items = g.sections.filter(matches)
          if (!items.length) return null
          return (
            <div key={g.title} className="settings-nav-group">
              <div className="settings-nav-heading">{g.title}</div>
              {items.map(({ id, label, icon: Icon }) => (
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
                  <Icon size={16} strokeWidth={1.75} />
                  {label}
                </button>
              ))}
            </div>
          )
        })}
      </nav>

      <main className="settings-main">
        <button type="button" className="settings-close" onClick={onClose} aria-label="Back to app" title="Back to app (Esc)">
          <ArrowLeft size={16} strokeWidth={1.75} />
        </button>
        <div className="settings-body" key={section}>
          <h1 className="settings-title">{current.label}</h1>
          <p className="settings-blurb">{current.blurb}</p>

          {section === 'general' && (
            <>
              <div className="settings-group-head">
                <h2>Inboxes</h2>
                <button type="button" className="settings-primary" onClick={onAddAccount}>
                  Add inbox
                </button>
              </div>
              <div className="settings-card">
                {(accounts.length ? accounts : email ? [{ accountId: 0, email, name: null }] : []).map((a) => (
                  <div key={a.accountId} className="setting-row">
                    <span className="settings-avatar" aria-hidden="true">
                      {(a.name ?? a.email).slice(0, 1).toUpperCase()}
                    </span>
                    <div className="setting-text">
                      <div className="setting-label">{a.name ?? a.email}</div>
                      {a.name && <div className="setting-desc">{a.email}</div>}
                    </div>
                  </div>
                ))}
              </div>

              <div className="settings-group-head">
                <h2>Appearance and shortcuts</h2>
              </div>
              <div className="settings-card">
                <div className="setting-row">
                  <div className="setting-text">
                    <div className="setting-label">Appearance</div>
                    <div className="setting-desc">Match your system theme or choose a fixed one.</div>
                  </div>
                  <div
                    className="settings-segmented"
                    role="radiogroup"
                    aria-label="Appearance"
                    style={{ '--i': Math.max(0, THEMES.findIndex((t) => t.id === theme)) } as React.CSSProperties}
                  >
                    <span className="settings-segmented-thumb" aria-hidden />
                    {THEMES.map(({ id, label, icon: Icon }) => (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={theme === id}
                        onClick={() => onTheme(id)}
                      >
                        <Icon size={14} strokeWidth={2} />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="setting-row">
                  <div className="setting-text">
                    <div className="setting-label">Common shortcuts</div>
                    <div className="setting-desc">Press ⌘. anytime.</div>
                  </div>
                  <button type="button" className="settings-link" onClick={onShortcuts}>
                    Show shortcuts
                  </button>
                </div>
              </div>
            </>
          )}

          {section === 'triage' && <TriageSettings />}

          {section === 'shortcuts' && <ShortcutSettings />}

          {section === 'snippets' && <SnippetSettings />}

          {section === 'ai' && <AiSettings />}

          {section === 'signature' && (
          <>
          <section className="settings-section">
            <p className="settings-note">
              Appended to new messages and replies. Select text to add a link, or
              insert a logo (PNG/JPG/GIF/WebP, under 512 KB).
            </p>
            {/* One box: toolbar, a faint divider, then the editor (no second border). */}
            <div className="sig-box">
              <div className="sig-toolbar">
                {sigMode === 'rich' && (
                  <>
                    <button
                      type="button"
                      className="compose-tool"
                      title="Bold ⌘B"
                      aria-label="Bold"
                      aria-pressed={!!activeFormats.bold}
                      data-on={!!activeFormats.bold}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => exec('bold')}
                    >
                      <Bold size={15} strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      className="compose-tool"
                      title="Italic ⌘I"
                      aria-label="Italic"
                      aria-pressed={!!activeFormats.italic}
                      data-on={!!activeFormats.italic}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => exec('italic')}
                    >
                      <Italic size={15} strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      className="compose-tool"
                      title="Insert link"
                      aria-label="Insert link"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={onLink}
                    >
                      <Link2 size={15} strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      className="compose-tool"
                      title="Remove link"
                      aria-label="Remove link"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => exec('unlink')}
                    >
                      <Unlink size={15} strokeWidth={1.75} />
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
                      <ImageIcon size={15} strokeWidth={1.75} />
                    </button>
                  </>
                )}
                <span className="sig-toolbar-spacer" />
                <div className="sig-mode" role="tablist" aria-label="Signature editor">
                  <button type="button" role="tab" aria-selected={sigMode === 'rich'} onClick={() => switchMode('rich')}>
                    Rich text
                  </button>
                  <button type="button" role="tab" aria-selected={sigMode === 'html'} onClick={() => switchMode('html')}>
                    HTML
                  </button>
                </div>
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
              {sigMode === 'rich' ? (
                <div
                  ref={editorRef}
                  className="settings-signature"
                  contentEditable
                  suppressContentEditableWarning
                  role="textbox"
                  aria-multiline="true"
                  aria-label="Signature"
                  onInput={onRichInput}
                  onKeyUp={refreshFormats}
                  onPaste={onPaste}
                  onBlur={save}
                />
              ) : (
                <textarea
                  className="settings-signature sig-html"
                  aria-label="Signature HTML"
                  spellCheck={false}
                  value={htmlText}
                  onChange={(e) => {
                    setHtmlText(e.target.value)
                    latest.current = e.target.value
                    autosave()
                  }}
                  onBlur={save}
                />
              )}
            </div>
            {linkError && <p className="settings-error">{linkError}</p>}
            {sigMode === 'html' && (
              <p className="settings-note sig-note">
                Saved through the same cleanup as a paste: scripts, styles and anything unsafe are removed.
              </p>
            )}
            <div className="settings-actions">
              <span className="settings-saved" data-on={saved}>
                Saved
              </span>
            </div>
          </section>
          </>
          )}
        </div>
      </main>
    </>
  )
}
