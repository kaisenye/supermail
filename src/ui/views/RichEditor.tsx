import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Bold, Italic, Link2, Strikethrough, Underline } from 'lucide-react'
import { applyLink, captureSelection, handlePaste, SAFE_HREF } from '../richText'
import { LinkPrompt } from './LinkPrompt'
import { useActiveFormats } from '../hooks/useActiveFormats'
import { filterSlashItems, slashQuery, type SlashItem } from '../slashMenu'

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

/** Inline elements a line's text can sit inside. */
const INLINE = /^(B|STRONG|I|EM|U|S|STRIKE|CODE|SPAN|A|FONT)$/

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
  const [active, refreshFormats] = useActiveFormats(elRef)
  const wrapRef = useRef<HTMLDivElement>(null)
  /** Where the format bar floats: over a selection, like Linear. Null hides it. */
  const [bubble, setBubble] = useState<{ top: number; left: number } | null>(null)
  /** The "/" menu: what was typed after the slash, where, and the highlighted row. */
  const [slash, setSlash] = useState<{ query: string; top: number; left: number; index: number } | null>(null)
  const slashItems = slash ? filterSlashItems(slash.query) : []

  // The format bar follows the selection: shown only while text is selected.
  useEffect(() => {
    const onSel = (): void => {
      const el = elRef.current
      const wrap = wrapRef.current
      const sel = window.getSelection()
      if (!el || !wrap || !sel || sel.rangeCount === 0 || sel.isCollapsed || !el.contains(sel.anchorNode)) {
        setBubble(null)
        return
      }
      const r = sel.getRangeAt(0).getBoundingClientRect()
      const w = wrap.getBoundingClientRect()
      // The bar is centred on `left`; keep all of it inside the editor.
      const half = 84
      setBubble({ top: r.top - w.top - 8, left: Math.max(half, Math.min(w.width - half, r.left - w.left + r.width / 2)) })
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])

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
      refreshFormats()
    },
    [save, refreshFormats]
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
    refreshFormats()
  }, [save, refreshFormats])

  /**
   * Opens a link on a plain click, which is what people expect.
   *
   * Editing the link text is still possible: a drag-select through it, or a
   * double/triple click, is not treated as a click-through, so text can be
   * selected and retyped. Alt-click also skips opening, to place the caret.
   */
  const onClickBody = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest?.('a')
    const href = anchor?.getAttribute('href')
    if (!href) return
    // Alt is the deliberate "let me edit this" escape hatch.
    if (e.altKey) return
    // A selection means the user is editing, not following.
    if (e.detail > 1) return
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    if (!SAFE_HREF.test(href)) return
    e.preventDefault()
    void window.api.openExternal(href)
  }, [])

  const openLink = useCallback(() => {
    setLinkRange(captureSelection(elRef.current))
    setLinkOpen(true)
  }, [])

  /**
   * Turns the caret's line into a block (h1, quote, …), keeping the text from
   * `from` on. formatBlock leaves a bare text node behind and creates an empty
   * sibling, so the block is built directly and the line moved into it.
   */
  const wrapLine = useCallback((tag: string, node: Node, from: number) => {
    const sel = window.getSelection()
    const block = document.createElement(tag)
    const rest = (node.textContent ?? '').slice(from)
    // An empty block needs a <br>: Chrome will not keep the caret in an empty
    // text node, so typing would land outside the block.
    const inner = rest ? document.createTextNode(rest) : document.createElement('br')
    block.appendChild(inner)
    // Climb out of inline wrappers (a line that starts bold, say) so the
    // block never ends up inside a <b>; then replace the whole line when it
    // is already a plain block.
    let target: Node = node
    while (target.parentNode && target.parentNode !== elRef.current && INLINE.test((target.parentNode as Element).tagName))
      target = target.parentNode
    const host = target.parentNode
    if (host && host !== elRef.current && /^(DIV|P|H[1-6]|BLOCKQUOTE|PRE)$/.test((host as Element).tagName))
      target = host
    target.parentNode?.replaceChild(block, target)
    const at = document.createRange()
    if (rest) at.setStart(inner, rest.length)
    else at.setStart(block, 0)
    at.collapse(true)
    sel?.removeAllRanges()
    sel?.addRange(at)
  }, [])

  /** Runs a "/" menu choice on the caret's line, after removing the "/query" typed. */
  const applySlash = useCallback(
    (item: SlashItem) => {
      const typed = slash?.query ?? ''
      setSlash(null)
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      let node: Node = range.startContainer
      if (node.nodeType !== Node.TEXT_NODE) return
      const end = range.startOffset
      const start = Math.max(0, end - typed.length - 1)
      node.textContent = (node.textContent ?? '').slice(0, start) + (node.textContent ?? '').slice(end)
      const at = document.createRange()
      at.setStart(node, start)
      at.collapse(true)
      sel.removeAllRanges()
      sel.addRange(at)
      if (item.id === 'ul') document.execCommand('insertUnorderedList')
      else if (item.id === 'ol') document.execCommand('insertOrderedList')
      else if (item.id === 'hr') document.execCommand('insertHorizontalRule')
      else {
        const tag = { p: 'p', h1: 'h1', h2: 'h2', h3: 'h3', quote: 'blockquote', code: 'pre' }[item.id] ?? 'p'
        // Text before the slash stays on its line; the block takes the rest.
        if (start > 0) {
          node = (node as Text).splitText(start)
          ;(node.previousSibling as Text | null)?.after(document.createElement('br'))
        }
        wrapLine(tag, node, 0)
      }
      save()
      refreshFormats()
    },
    [slash, wrapLine, save, refreshFormats]
  )

  /** After each keystroke: open, narrow or close the "/" menu. */
  const onInput = useCallback(() => {
    const line = lineBeforeCaret()
    const q = line ? slashQuery(line.text) : null
    if (q === null || !wrapRef.current) return setSlash(null)
    const r = line!.range.getBoundingClientRect()
    const w = wrapRef.current.getBoundingClientRect()
    setSlash((cur) => ({ query: q, top: r.bottom - w.top + 6, left: r.left - w.left, index: cur && cur.query === q ? cur.index : 0 }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // The "/" menu owns arrows, Enter, Tab and Esc while it is open.
      if (slash && slashItems.length) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const d = e.key === 'ArrowDown' ? 1 : -1
          setSlash({ ...slash, index: (slash.index + d + slashItems.length) % slashItems.length })
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          applySlash(slashItems[slash.index] ?? slashItems[0])
          return
        }
      }
      if (slash && e.key === 'Escape') {
        // This Esc is the menu's, not the task card's.
        e.preventDefault()
        e.stopPropagation()
        setSlash(null)
        return
      }
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
            wrapLine(rule.tag, node, line.range.startOffset)
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
          sel?.collapseToEnd()
          // The caret now sits at the end of the <b>, where Chrome keeps
          // typing bold; toggling once more turns it off for what comes next.
          if (document.queryCommandState(rule.cmd)) document.execCommand(rule.cmd)
        }
        save()
      }
    },
    [exec, openLink, save, slash, slashItems, applySlash, wrapLine]
  )

  const btn = (
    title: string,
    icon: React.ReactNode,
    action: () => void,
    /** Key in the active-format map, so the button reads as pressed. */
    format?: string
  ): React.ReactElement => (
    <button
      type="button"
      title={title}
      aria-pressed={format ? !!active[format] : undefined}
      data-on={format ? !!active[format] : undefined}
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
    <div className={`rte ${className ?? ''}`} ref={wrapRef}>
      {bubble && (
      <div className="rte-toolbar rte-bubble" style={{ top: bubble.top, left: bubble.left }} role="toolbar" aria-label="Format">
        {btn('Bold  ⌘B', <Bold size={13} strokeWidth={2.25} />, () => exec('bold'), 'bold')}
        {btn('Italic  ⌘I', <Italic size={13} strokeWidth={2.25} />, () => exec('italic'), 'italic')}
        {btn('Underline  ⌘U', <Underline size={13} strokeWidth={2.25} />, () =>
          exec('underline'), 'underline'
        )}
        {btn('Strikethrough  ⌘⇧X', <Strikethrough size={13} strokeWidth={2.25} />, strike, 'strike')}
        <span className="rte-sep" />
        {btn('Link  ⌘K', <Link2 size={13} strokeWidth={2.25} />, openLink)}
      </div>
      )}

      {slash && slashItems.length > 0 && (
        <div className="rte-slash" style={{ top: slash.top, left: slash.left }} role="listbox" aria-label="Turn into">
          {slashItems.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={i === slash.index}
              onMouseDown={(e) => {
                // Keep the caret in the editor while choosing.
                e.preventDefault()
                applySlash(item)
              }}
              onMouseEnter={() => setSlash({ ...slash, index: i })}
            >
              <span>{item.label}</span>
              {item.hint && <kbd>{item.hint}</kbd>}
            </button>
          ))}
        </div>
      )}

      <div
        ref={elRef}
        className="rte-body"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onKeyDown={onKeyDown}
        onKeyUp={refreshFormats}
        onInput={onInput}
        onClick={onClickBody}
        onPaste={(e) => handlePaste(e, elRef.current, save)}
        onBlur={() => {
          setSlash(null)
          save()
        }}
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
