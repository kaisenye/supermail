import { useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Attachment } from '../../../electron/preload'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

interface Props {
  attachment: Attachment
  onClose: () => void
  onSave: () => void
  onOpen: () => void
}

/** Beyond this a table stops being readable and starts being a scroll hazard. */
const MAX_CSV_ROWS = 300

export type PreviewKind = 'image' | 'svg' | 'pdf' | 'video' | 'audio' | 'text' | 'csv' | 'markdown'

const EXT_KINDS: Record<string, PreviewKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  svg: 'svg',
  pdf: 'pdf',
  mp4: 'video', webm: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio',
  txt: 'text', log: 'text', json: 'text', xml: 'text',
  csv: 'csv', tsv: 'csv',
  md: 'markdown', markdown: 'markdown'
}

/**
 * Decides how to preview from mime first, filename second. Unknown returns
 * null and the caller falls back to a plain save/open chip.
 */
export function previewKind(a: Attachment): PreviewKind | null {
  const mime = (a.mime ?? '').toLowerCase().split(';')[0].trim()
  if (mime === 'image/svg+xml') return 'svg'
  if (mime === 'application/pdf') return 'pdf'
  if (mime === 'text/csv' || mime === 'text/tab-separated-values') return 'csv'
  if (mime === 'text/markdown') return 'markdown'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('text/') || mime === 'application/json') return 'text'

  const ext = (a.filename ?? '').toLowerCase().split('.').pop() ?? ''
  return EXT_KINDS[ext] ?? null
}

type Loaded =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'ready'; kind: PreviewKind; dataUrl: string; text: string; base64: string }

/**
 * Modal preview. Bytes arrive over IPC only once this mounts, so opening a
 * thread never pays for a 20MB PDF.
 */
export function AttachmentPreview({ attachment, onClose, onSave, onOpen }: Props) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const kind = previewKind(attachment)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    if (!kind) return
    let cancelled = false
    setLoaded({ state: 'loading' })
    window.api
      .attachmentData(attachment.id)
      .then((r) => {
        if (cancelled) return
        if (!r.ok) return setLoaded({ state: 'error', error: r.error })
        const textual = kind === 'text' || kind === 'csv' || kind === 'markdown'
        setLoaded({
          state: 'ready',
          kind,
          dataUrl: textual || kind === 'pdf' ? '' : `data:${r.mime};base64,${r.base64}`,
          text: textual ? decodeBase64Utf8(r.base64) : '',
          base64: r.base64
        })
      })
      .catch((e: Error) => {
        if (!cancelled) setLoaded({ state: 'error', error: e.message })
      })
    return () => {
      cancelled = true
    }
  }, [attachment.id, kind])

  const name = attachment.filename ?? 'untitled'

  return (
    <div
      className="preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${name}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="preview">
        <header className="preview-head">
          <span className="preview-title" title={name}>
            {name}
          </span>
          <button type="button" onClick={onOpen}>
            Open
          </button>
          <button type="button" onClick={onSave}>
            Save
          </button>
          <button type="button" onClick={onClose} aria-label="Close preview">
            Esc
          </button>
        </header>
        <div className="preview-stage">
          <PreviewStage loaded={loaded} kind={kind} />
        </div>
      </div>
    </div>
  )
}

function PreviewStage({ loaded, kind }: { loaded: Loaded; kind: PreviewKind | null }) {
  const srcDoc = useMemo(
    () => (loaded.state === 'ready' ? buildPreviewDoc(loaded.kind, loaded.dataUrl, loaded.text) : ''),
    [loaded]
  )

  if (!kind) return <div className="preview-note">No preview for this file type.</div>
  if (loaded.state === 'loading') return <div className="preview-note">Loading…</div>
  if (loaded.state === 'error') return <div className="preview-note preview-error">{loaded.error}</div>

  // Chromium's PDF viewer is a plugin, and a sandboxed frame refuses plugins.
  // pdf.js rasterises to canvas instead — no plugin, no unsandboxed frame.
  if (loaded.kind === 'pdf') return <PdfCanvas base64={loaded.base64} />

  return (
    <iframe
      className="preview-frame"
      /*
       * Same opaque sandbox as the message body: no allow-scripts and no
       * allow-same-origin, so attacker-controlled bytes cannot run code or
       * reach window.api. The frame's own CSP blocks every network egress.
       */
      sandbox=""
      srcDoc={srcDoc}
      title="Attachment preview"
    />
  )
}

/** Beyond this the preview is a scroll hazard; Open shows the rest. */
const MAX_PDF_PAGES = 20

/**
 * Renders a PDF to canvas with pdf.js. Untrusted bytes are parsed in pdf.js's
 * worker rather than by a plugin, so this needs no unsandboxed frame.
 */
function PdfCanvas({ base64 }: { base64: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'rendering' | 'done' | string>('rendering')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false

    ;(async () => {
      try {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
        const doc = await pdfjs.getDocument({ data: bytes }).promise
        if (cancelled) return
        host.replaceChildren()

        const count = Math.min(doc.numPages, MAX_PDF_PAGES)
        for (let n = 1; n <= count; n++) {
          const page = await doc.getPage(n)
          if (cancelled) return
          const vp = page.getViewport({ scale: 1.4 })
          const cv = document.createElement('canvas')
          cv.className = 'pdf-page'
          cv.width = vp.width
          cv.height = vp.height
          host.appendChild(cv)
          // intent:'print' avoids pdf.js's requestAnimationFrame pump, which
          // never fires while the window is hidden or occluded — that hangs.
          await page.render({
            canvas: cv,
            viewport: vp,
            intent: 'print',
            annotationMode: pdfjs.AnnotationMode.ENABLE
          }).promise
          if (cancelled) return
        }
        setStatus(
          doc.numPages > count
            ? `Showing first ${count} of ${doc.numPages} pages. Open to see all.`
            : 'done'
        )
      } catch (e) {
        if (!cancelled) setStatus('Could not render PDF: ' + (e as Error).message)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [base64])

  return (
    <div className="pdf-view">
      {status === 'rendering' && <div className="preview-note">Rendering…</div>}
      {status !== 'rendering' && status !== 'done' && (
        <div className="preview-note">{status}</div>
      )}
      <div ref={hostRef} />
    </div>
  )
}

/** Base64 → UTF-8 text, so non-ASCII CSV/markdown does not turn into mojibake. */
function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** RFC4180-ish: handles quoted fields, escaped quotes and embedded newlines. */
function parseCsv(text: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
      continue
    }
    if (c === '"') quoted = true
    else if (c === delim) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function csvTable(text: string, delim: string): string {
  const rows = parseCsv(text, delim)
  const shown = rows.slice(0, MAX_CSV_ROWS)
  const head = shown[0] ?? []
  const body = shown.slice(1)

  const cells = (cs: string[], tag: string): string =>
    cs.map((c) => `<${tag}>${esc(c)}</${tag}>`).join('')

  const note =
    rows.length > MAX_CSV_ROWS
      ? `<p class="note">Showing first ${MAX_CSV_ROWS} of ${rows.length} rows. Save or open the file to see all.</p>`
      : ''

  return `${note}<table><thead><tr>${cells(head, 'th')}</tr></thead>
<tbody>${body.map((r) => `<tr>${cells(r, 'td')}</tr>`).join('')}</tbody></table>`
}

/**
 * Minimal markdown: headings, bold/italic, code and links. Everything is
 * escaped before any tag is added, so the source can never inject HTML.
 */
function markdownHtml(text: string): string {
  const inline = (s: string): string =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      // Only http(s) survives; the frame CSP blocks navigation anyway.
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')

  return text
    .split(/\n{2,}/)
    .map((block) => {
      const h = /^(#{1,6})\s+(.*)$/.exec(block.trim())
      if (h) return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`
      return `<p>${inline(block).replace(/\n/g, '<br />')}</p>`
    })
    .join('')
}

/**
 * Builds the sandboxed document. The frame CSP is the real control: only the
 * one data: URL we injected may load, and every remote fetch is denied — so
 * an SVG or PDF cannot phone home even if it tries.
 */
function buildPreviewDoc(kind: PreviewKind, dataUrl: string, text: string): string {
  // The frame can't read our CSS vars, so the theme is resolved here and
  // inlined — otherwise text is unreadable in whichever mode it guesses wrong.
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches
  const fg = dark ? '#ececed' : '#16161a'

  const css = `
    html,body { margin:0; padding:0; background:transparent; }
    body {
      font-family: 'Inter Tight', -apple-system, sans-serif;
      font-size: 13px; line-height: 1.55; color: ${fg};
      overflow-wrap: anywhere;
    }
    .fit { display:block; max-width:100%; height:auto; margin:0 auto; }
    .full { width:100%; height:100vh; border:0; display:block; }
    pre { white-space: pre-wrap; font-family: 'JetBrains Mono', monospace; font-size: 12px; margin:0; }
    table { border-collapse: collapse; font-size: 12px; width:100%; }
    th, td { border:1px solid rgba(128,128,128,0.3); padding:3px 6px; text-align:left; }
    th { position: sticky; top: 0; background: rgba(128,128,128,0.12); }
    .note { font-size: 11px; opacity: 0.75; margin: 0 0 8px; }
    a { color: #6b8aff; }`

  let inner: string
  switch (kind) {
    case 'image':
      inner = `<img class="fit" src="${dataUrl}" alt="" />`
      break
    // SVG is rendered as an <img>, not inline: image context never runs
    // script, loads externals, or reaches this document.
    case 'svg':
      inner = `<img class="fit" src="${dataUrl}" alt="" />`
      break
    case 'video':
      inner = `<video class="fit" controls src="${dataUrl}"></video>`
      break
    case 'audio':
      inner = `<audio controls src="${dataUrl}" style="width:100%"></audio>`
      break
    case 'csv':
      inner = csvTable(text, text.includes('\t') ? '\t' : ',')
      break
    case 'markdown':
      inner = markdownHtml(text)
      break
    default:
      inner = `<pre>${esc(text)}</pre>`
  }

  return `<!doctype html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; object-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">
<style>${css}</style>
</head><body>${inner}</body></html>`
}
