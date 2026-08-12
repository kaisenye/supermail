import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Strikethrough,
  Underline
} from 'lucide-react'
import { applyLink, captureSelection, handlePaste, SAFE_HREF } from '../richText'
import { LinkPrompt } from './LinkPrompt'

/**
 * Markdown shorthands applied on space. Each maps a line prefix to the block
 * it should become — typing "# " gives a heading rather than leaving the hash.
 */
const BLOCK_RULES: { pattern: RegExp; tag?: string; run?: () => void }[] = [
  { pattern: /^#$/, tag: 'h1' },
  { pattern: /^##$/, tag: 'h2' },
  { pattern: /^###$/, tag: 'h3' },
  { pattern: /^[-*]$/, run: () => document.execCommand('insertUnorderedList') },
  { pattern: /^1\.$/, run: () => document.execCommand('insertOrderedList') },
  { pattern: /^>$/, tag: 'blockquote' }
]

/**
 * Inline shorthands closed by their own delimiter, e.g. **bold**. `tag` wraps
 * the match directly — there is no execCommand for inline code.
 */
const INLINE_RULES: { pattern: RegExp; cmd?: string; tag?: string }[] = [
  { pattern: /\*\*([^*]+)\*\*$/, cmd: 'bold' },
  { pattern: /(?<!\*)\*([^*]+)\*$/, cmd: 'italic' },
  { pattern: /`([^`]+)`$/, tag: 'code' },
  { pattern: /~~([^~]+)~~$/, tag: 's' }
]

export interface RichEditorHandle {
  /** Replaces the content; used when switching to a different task. */
  setHtml: (html: string) => void
  getHtml: () => string
  focus: () => void
}

interface Props {
  ref?: RefObject<RichEditorHandle | null>
  className?: string
  placeholder?: string
  /** Fires on blur and after any toolbar action, not on every keystroke. */
  onSave: (html: string) => void
  /** Compact hides the toolbar until the editor is focused. */
  autoFocus?: boolean
}

export function RichEditor({ ref, className, placeholder, onSave, autoFocus }: Props) {
  const elRef = useRef<HTMLDivElement>(null)
  const [linkRange, setLinkRange] = useState<Range | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)

  useImperativeHandle(ref, () => ({
    setHtml: (html: string) => {
      if (elRef.current) elRef.current.innerHTML = html
    },
    getHtml: () => elRef.current?.innerHTML ?? '',
    focus: () => elRef.current?.focus()
  }))

  useEffect(() => {
    if (autoFocus) elRef.current?.focus()
  }, [autoFocus])

  const save = useCallback(() => {
    if (elRef.current) onSave(elRef.current.innerHTML)
  }, [onSave])

  /** Runs a command and keeps focus in the editor so typing continues. */
  const exec = useCallback(
    (cmd: string, value?: string) => {
      elRef.current?.focus()
      document.execCommand(cmd, false, value)
      save()
    },
    [save]
  )

  /**
   * execCommand('strikeThrough') emits <strike>, which the sanitiser strips on
   * save. Wrap the selection in <s> instead — allowed, and the modern tag.
   */
  const strike = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
    const range = sel.getRangeAt(0)
    try {
      const wrap = document.createElement('s')
      range.surroundContents(wrap)
    } catch {
      // surroundContents throws when the selection spans element boundaries;
      // the command is a good-enough fallback there.
      document.execCommand('strikeThrough')
    }
    save()
  }, [save])

  /**
   * Opens a link in the browser. Plain click would fight text editing — the
   * caret has to be placeable inside link text — so require a modifier, which
   * is what every editor of this kind does.
   */
  const onClickBody = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest?.('a')
    const href = anchor?.getAttribute('href')
    if (!href) return
    if (!(e.metaKey || e.ctrlKey)) return
    if (!SAFE_HREF.test(href)) return
    e.preventDefault()
    void window.api.openExternal(href)
  }, [])

  const openLink = useCallback(() => {
    setLinkRange(captureSelection(elRef.current))
    setLinkOpen(true)
  }, [])

  /** Text of the current line up to the caret, for markdown rules. */
  const lineBeforeCaret = (): { text: string; range: Range } | null => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null
    const range = sel.getRangeAt(0)
    const node = range.startContainer
    if (node.nodeType !== Node.TEXT_NODE) return null
    return { text: (node.textContent ?? '').slice(0, range.startOffset), range }
  }

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const meta = e.metaKey || e.ctrlKey

      if (meta && !e.altKey) {
        const k = e.key.toLowerCase()
        // The browser handles B/I/U natively, but not consistently across
        // contenteditable, so drive them explicitly and save after.
        if (k === 'b') return void (e.preventDefault(), exec('bold'))
        if (k === 'i') return void (e.preventDefault(), exec('italic'))
        if (k === 'u') return void (e.preventDefault(), exec('underline'))
        if (k === 'k') return void (e.preventDefault(), openLink())
        if (e.shiftKey && k === 'x') return void (e.preventDefault(), strike())
        if (e.shiftKey && k === '7') return void (e.preventDefault(), exec('insertOrderedList'))
        if (e.shiftKey && k === '8') return void (e.preventDefault(), exec('insertUnorderedList'))
      }

      if (e.key === ' ') {
        const line = lineBeforeCaret()
        if (!line) return
        const rule = BLOCK_RULES.find((r) => r.pattern.test(line.text))
        if (rule) {
          e.preventDefault()
          // Select the marker and replace it with a zero-width space, so the
          // block has content to wrap. formatBlock is a no-op on an empty
          // block, and stripping the marker first leaves nothing to format.
          const node = line.range.startContainer
          const sel = window.getSelection()

          if (rule.tag) {
            // formatBlock leaves a bare text node behind and creates an empty
            // sibling, so build the block directly and move the line into it.
            const block = document.createElement(rule.tag)
            // Always give the block a text node: the caret cannot sit inside an
            // element with no children, so typing would land outside it.
            const rest = (node.textContent ?? '').slice(line.range.startOffset)
            const inner = document.createTextNode(rest)
            block.appendChild(inner)

            const host = node.parentNode
            // Replace the whole line, not just the text node, when the line is
            // already wrapped in a plain div.
            const target =
              host && host !== elRef.current && (host as Element).tagName === 'DIV'
                ? (host as Element)
                : node
            target.parentNode?.replaceChild(block, target)

            const at = document.createRange()
            at.setStart(inner, 0)
            at.collapse(true)
            sel?.removeAllRanges()
            sel?.addRange(at)
          } else {
            // List commands wrap the current line correctly on their own; the
            // marker just has to go first.
            node.textContent = (node.textContent ?? '').slice(line.range.startOffset)
            const at = document.createRange()
            at.setStart(node, 0)
            at.collapse(true)
            sel?.removeAllRanges()
            sel?.addRange(at)
            rule.run?.()
          }
          save()
        }
        return
      }

      // Inline rules fire on their closing character.
      if (e.key === '*' || e.key === '`' || e.key === '~') {
        const line = lineBeforeCaret()
        if (!line) return
        const candidate = line.text + e.key
        const rule = INLINE_RULES.find((r) => r.pattern.test(candidate))
        if (!rule) return
        const m = rule.pattern.exec(candidate)
        if (!m) return
        e.preventDefault()
        const node = line.range.startContainer
        const full = m[0]
        const inner = m[1]
        const start = line.range.startOffset + 1 - full.length
        const text = node.textContent ?? ''
        node.textContent = text.slice(0, start) + inner + text.slice(line.range.startOffset)
        const sel = window.getSelection()
        const sr = document.createRange()
        sr.setStart(node, start)
        sr.setEnd(node, start + inner.length)
        sel?.removeAllRanges()
        sel?.addRange(sr)
        if (rule.tag) {
          const wrap = document.createElement(rule.tag)
          sr.surroundContents(wrap)
          // Leave the caret after the wrapper, outside it, so typing continues
          // in plain text rather than extending the code span.
          const after = document.createRange()
          after.setStartAfter(wrap)
          after.collapse(true)
          sel?.removeAllRanges()
          sel?.addRange(after)
        } else if (rule.cmd) {
          document.execCommand(rule.cmd)
          // Collapse to the end so typing continues unformatted.
          sel?.collapseToEnd()
        }
        save()
      }
    },
    [exec, openLink, save]
  )

  const btn = (
    title: string,
    icon: React.ReactNode,
    action: () => void
  ): React.ReactElement => (
    <button
      type="button"
      title={title}
      // mousedown, not click: click fires after the editor loses its selection.
      onMouseDown={(e) => {
        e.preventDefault()
        action()
      }}
    >
      {icon}
    </button>
  )

  return (
    <div className={`rte ${className ?? ''}`}>
      <div className="rte-toolbar">
        {btn('Bold  ⌘B', <Bold size={13} strokeWidth={2.25} />, () => exec('bold'))}
        {btn('Italic  ⌘I', <Italic size={13} strokeWidth={2.25} />, () => exec('italic'))}
        {btn('Underline  ⌘U', <Underline size={13} strokeWidth={2.25} />, () =>
          exec('underline')
        )}
        {btn('Strikethrough  ⌘⇧X', <Strikethrough size={13} strokeWidth={2.25} />, strike)}
        <span className="rte-sep" />
        {btn('Heading 1', <Heading1 size={13} strokeWidth={2.25} />, () =>
          exec('formatBlock', 'h1')
        )}
        {btn('Heading 2', <Heading2 size={13} strokeWidth={2.25} />, () =>
          exec('formatBlock', 'h2')
        )}
        <span className="rte-sep" />
        {btn('Bulleted list  ⌘⇧8', <List size={13} strokeWidth={2.25} />, () =>
          exec('insertUnorderedList')
        )}
        {btn('Numbered list  ⌘⇧7', <ListOrdered size={13} strokeWidth={2.25} />, () =>
          exec('insertOrderedList')
        )}
        {btn('Quote', <Quote size={13} strokeWidth={2.25} />, () =>
          exec('formatBlock', 'blockquote')
        )}
        {btn('Code', <Code size={13} strokeWidth={2.25} />, () => exec('formatBlock', 'pre'))}
        <span className="rte-sep" />
        {btn('Link  ⌘K', <Link2 size={13} strokeWidth={2.25} />, openLink)}
      </div>

      <div
        ref={elRef}
        className="rte-body"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onKeyDown={onKeyDown}
        onClick={onClickBody}
        onPaste={(e) => handlePaste(e, elRef.current, save)}
        onBlur={save}
      />

      {linkOpen && (
        <LinkPrompt
          onCancel={() => setLinkOpen(false)}
          onSubmit={(url) => {
            applyLink(elRef.current, linkRange, url, save)
            setLinkOpen(false)
          }}
        />
      )}
    </div>
  )
}
