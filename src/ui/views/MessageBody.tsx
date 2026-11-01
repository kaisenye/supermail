import { useEffect, useMemo, useRef, useState } from 'react'
import { Ellipsis } from 'lucide-react'
import type { Attachment, BodyResult } from '../../../electron/preload'
import { AttachmentList } from './AttachmentList'

interface Props {
  messageId: number
  /** Called once the body is in: the thread needs links (Tab) and attachments (⌘O). */
  onLoaded?: (info: { links: string[]; attachments: Attachment[] }) => void
  /** Index into this message's links that Tab selected, or null. */
  activeLink?: number | null
}

/**
 * Renders email HTML inside a sandboxed iframe. The HTML is already sanitised
 * in the main process; the sandbox is the second layer, and srcdoc with no
 * allow-same-origin means the frame cannot reach window.api or our storage.
 */
export function MessageBody({ messageId, onLoaded, activeLink }: Props) {
  const [body, setBody] = useState<BodyResult | null>(null)
  const [showImages, setShowImages] = useState(false)
  const [showQuotes, setShowQuotes] = useState(false)
  const [height, setHeight] = useState(120)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setBody(null)
    setHeight(120)
    window.api.getBody(messageId, showImages).then((r) => {
      if (!cancelled) setBody(r)
    })
    return () => {
      cancelled = true
    }
  }, [messageId, showImages])

  /**
   * Quoted history (marked in main) folds behind "•••". A message that is
   * nothing but history (a forward with no note) opens unfolded instead of
   * showing an empty card.
   */
  const { hasQuotes, onlyQuoted } = useMemo(() => {
    if (!body?.ok || !/\sdata-quoted\b/.test(body.html)) return { hasQuotes: false, onlyQuoted: false }
    const d = new DOMParser().parseFromString(`<body>${body.html}</body>`, 'text/html')
    d.querySelectorAll('[data-quoted]').forEach((n) => n.remove())
    const visible = (d.body.textContent ?? '').replace(/\u00a0/g, ' ').trim() !== '' || !!d.body.querySelector('img')
    return { hasQuotes: true, onlyQuoted: !visible }
  }, [body])

  useEffect(() => {
    if (body?.ok) onLoaded?.({ links: extractLinks(body.html), attachments: body.attachments })
    // onLoaded is a fresh closure each render; only a new body should report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body])

  /**
   * The frame is fully opaque (no allow-scripts, no allow-same-origin), so
   * neither side can measure across the boundary. Instead a hidden host-side
   * probe lays out the same sanitised HTML at the same width and reports its
   * height. The probe never loads remote images and runs no scripts, so it
   * costs nothing in privilege.
   */
  useEffect(() => {
    const probe = probeRef.current
    if (!probe || !body?.ok) return

    let raf = 0
    const measure = (): void => {
      const h = probe.scrollHeight
      if (h > 0) setHeight(Math.min(20000, Math.max(40, h + 8)))
    }

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    })
    observer.observe(probe)
    measure()

    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [body, showQuotes, onlyQuoted])

  if (!body) {
    // Skeleton rather than a word: the body arrives in well under a second on
    // a warm cache, and swapping "Loading…" for text is a visible jolt.
    // Widths vary so it reads as prose, not a progress bar.
    return (
      <div className="body-skeleton" aria-busy="true" aria-label="Loading message">
        {(() => {
          // Stagger from the line index, not a CSS nth- selector: the paragraph
          // gap is a sibling div, so nth-child and nth-of-type both miscount it.
          let line = 0
          return [96, 88, 92, 70, 0, 84, 90, 62].map((w, i) =>
            w === 0 ? (
              <div key={i} className="skeleton-gap" />
            ) : (
              <div
                key={i}
                className="skeleton-line"
                style={{ width: `${w}%`, animationDelay: `${line++ * 0.08}s` }}
              />
            )
          )
        })()}
      </div>
    )
  }
  if (!body.ok) return <div className="body-error">{body.error}</div>

  const doc = buildDoc(body.html, showQuotes || onlyQuoted)
  const links = extractLinks(body.html)

  return (
    <div className="message-body">
      {body.blockedImages > 0 && !showImages && (
        <div className="images-blocked">
          <span>
            {body.blockedImages} remote image{body.blockedImages === 1 ? '' : 's'} blocked
          </span>
          <button onClick={() => setShowImages(true)}>Load images</button>
        </div>
      )}
      {/*
        Hidden measuring probe. Content is the same main-process-sanitised
        HTML; React's innerHTML never executes <script> tags, and the probe is
        aria-hidden and visually removed so it is inert in every sense.
      */}
      <div
        ref={probeRef}
        className="body-probe"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: doc.probeHtml }}
      />
      <iframe
        ref={frameRef}
        className="body-frame"
        style={{ height }}
        /*
         * Still no allow-scripts (nothing executes) and no allow-same-origin
         * (the frame cannot reach window.api, our storage, or this document).
         * Height is measured by a hidden host-side probe.
         *
         * The sanitiser gives every link target="_blank", which a sandbox
         * blocks silently unless allow-popups is set; main's window-open
         * handler then denies the window and opens the link in the real
         * browser. top-navigation-by-user-activation covers a link that
         * targets _top the same way (will-navigate).
         */
        sandbox="allow-popups allow-top-navigation-by-user-activation"
        srcDoc={doc.srcDoc}
        title="Message body"
      />
      {hasQuotes && !onlyQuoted && (
        <button
          type="button"
          className="quotes-toggle"
          aria-expanded={showQuotes}
          title={showQuotes ? 'Hide quoted history' : 'Show quoted history'}
          aria-label={showQuotes ? 'Hide quoted history' : 'Show quoted history'}
          onClick={() => setShowQuotes((v) => !v)}
        >
          <Ellipsis size={14} strokeWidth={2} />
        </button>
      )}
      {/* Links open on click via the host. This list stays as the way to see
          every destination at once before following any of them. */}
      {links.length > 0 && (
        <details className="body-links" open={activeLink != null ? true : undefined}>
          <summary>
            {links.length} link{links.length === 1 ? '' : 's'}
          </summary>
          <ul>
            {links.map((href, i) => (
              <li key={i} data-active={i === activeLink}>
                <button
                  onClick={() => window.api.openExternal(href)}
                  title={href}
                >
                  {href}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {body.attachments.length > 0 && <AttachmentList attachments={body.attachments} />}
    </div>
  )
}

/** Unique http(s) links, in document order. */
function extractLinks(html: string): string[] {
  const found = new Set<string>()
  for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gi)) {
    const href = m[1].replace(/&amp;/g, '&')
    if (/^https?:\/\//i.test(href)) found.add(href)
  }
  return [...found].slice(0, 50)
}

/** Styles are inlined so the frame needs no network and inherits our theme. */
function buildDoc(
  html: string,
  showQuotes: boolean
): { srcDoc: string; probeHtml: string } {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches

  const fg = dark ? '#ececed' : '#16161a'
  const muted = dark ? '#6e6e78' : '#86868f'
  const link = dark ? '#8aa4ff' : '#2244cc'
  const quote = dark ? 'rgba(255,255,255,0.12)' : 'rgba(17,17,16,0.14)'

  const css = `
    html,body { margin:0; padding:0; background:transparent; overflow:hidden; }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      font-size: 13.5px; line-height: 1.55; color: ${fg};
      word-wrap: break-word; overflow-wrap: anywhere;
    }
    img { max-width: 100%; height: auto; }
    a { color: ${link}; }
    blockquote {
      margin: 8px 0; padding-left: 12px;
      border-left: 2px solid ${quote}; color: ${muted};
    }
    pre { white-space: pre-wrap; font-family: 'JetBrains Mono', monospace; font-size: 12px; }
    table { max-width: 100%; }
    p { margin: 0 0 10px; }
    [data-quoted] { display: none; }
    .show-quotes [data-quoted] { display: revert; }`

  // The frame cannot script, so collapsing is a CSS class swapped from here.
  const cls = showQuotes ? ' class="show-quotes"' : ''

  const srcDoc = `<!doctype html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src https: http: data: cid:; style-src 'unsafe-inline'">
<style>${css}</style>
  <!-- No script here: the sandbox withholds allow-scripts on purpose.
       A hidden host-side probe measures height from outside. -->
</head><body${cls}>${html}</body></html>`

  // The probe reuses the frame's HTML and CSS so its layout — and therefore
  // its height — matches. Blocked images keep data-blocked-src, so it makes
  // no network requests of its own.
  return {
    srcDoc,
    probeHtml: `<style>${css}</style><div${cls}>${html}</div>`
  }
}
