import { useCallback, useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Clock, Star } from 'lucide-react'
import type { MessageListRow } from '../../core/store/types'
import { formatDate, isFlagged, isUnread, recipientLabel, senderLabel } from '../format'
import { rowChips, type LabelChipView, type LabelColors } from '../labelChips'
import { BrandMark } from './BrandMark'
import { withDateGroups, type ListItem } from '../listGroups'

const ROW_HEIGHT = 32
/** Rows from the end at which the next ones are fetched. */
const LOAD_AHEAD = 15
/** A bucket header: a small gap above the label, then a hairline. The first one has no gap. */
const GROUP_HEIGHT = 44
const FIRST_GROUP_HEIGHT = 32

interface Props {
  rows: MessageListRow[]
  selectedIndex: number
  checkedIds: number[]
  onSelect: (i: number) => void
  /** The mouse moved onto a row: cursor only, no scroll, no range anchor. */
  onHover?: (i: number) => void
  onToggleCheck: (id: number, index: number, shiftKey: boolean) => void
  onOpen?: (i: number) => void
  /** More rows are being fetched (the loader at the bottom shows). */
  loadingMore?: boolean
  /** False once neither SQLite nor the server has older mail for this view. */
  hasMore?: boolean
  /** Scrolled near the end: fetch the next rows and append them. */
  onLoadMore?: () => void
  emptyTitle?: string
  emptySub?: string
  /** Replaces the empty message entirely (the inbox-zero art). */
  emptyNode?: ReactNode
  /** Sent/Drafts: the sender is always the user, so show the recipient. */
  showRecipient?: boolean
  /** Date headers (Today, Yesterday, …) between runs of rows. */
  groupByDate?: boolean
  /** Gmail label colours, so a label chip wears the colour set in Gmail. */
  labelColors?: LabelColors
}

export function MessageList({
  labelColors,
  rows,
  selectedIndex,
  checkedIds,
  onSelect,
  onHover,
  onToggleCheck,
  onOpen,
  loadingMore,
  hasMore = false,
  onLoadMore,
  emptyTitle = 'No messages',
  emptySub,
  emptyNode,
  showRecipient = false,
  groupByDate = false,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Set by a shift-click so the change that follows it is ignored. */
  const shiftHandled = useRef(false)
  /**
   * Where the pointer last really moved. j/k scrolls rows under a still
   * pointer, and Chromium then fires mousemove at the same spot; following
   * that would drag the cursor back under the mouse.
   */
  const lastPointer = useRef({ x: -1, y: -1 })
  /** Set when the cursor moved under the mouse: keyboard moves scroll, hover never does. */
  const hovered = useRef(false)
  const checked = new Set(checkedIds)

  const items = useMemo<ListItem[]>(
    () =>
      groupByDate
        ? withDateGroups(rows, new Date())
        : rows.map((_, index) => ({ kind: 'row' as const, index })),
    [rows, groupByDate]
  )
  /** Row index -> item index, so the keyboard cursor can scroll a grouped list. */
  const itemOfRow = useMemo(() => {
    const out: number[] = []
    items.forEach((it, i) => {
      if (it.kind === 'row') out[it.index] = i
    })
    return out
  }, [items])
  // Sizes are recomputed only when count or getItemKey changes; a refresh can
  // move a header without changing the count, so the key function follows items.
  const getItemKey = useCallback(
    (i: number) => {
      const it = items[i]
      return it.kind === 'header' ? `h${i}:${it.label}` : rows[it.index].id
    },
    [items, rows]
  )

  const virtualizer = useVirtualizer({
    count: items.length,
    getItemKey,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) =>
      items[i]?.kind === 'header' ? (i === 0 ? FIRST_GROUP_HEIGHT : GROUP_HEIGHT) : ROW_HEIGHT,
    // Room after the last row for the loader.
    paddingEnd: 56,
    overscan: 12
  })

  useEffect(() => {
    // A row at the edge must not creep into view as the mouse passes over it.
    if (hovered.current) {
      hovered.current = false
      return
    }
    if (rows.length) virtualizer.scrollToIndex(itemOfRow[selectedIndex] ?? 0, { align: 'auto' })
  }, [selectedIndex, rows.length, itemOfRow, virtualizer])

  const virtualItems = virtualizer.getVirtualItems()

  // Infinite list: once the rendered rows reach within LOAD_AHEAD of the end,
  // ask for more. Keyboard moves scroll the list too, so j past the end loads.
  const lastRendered = virtualItems.length ? virtualItems[virtualItems.length - 1].index : -1
  useEffect(() => {
    if (onLoadMore && hasMore && !loadingMore && rows.length && lastRendered >= items.length - LOAD_AHEAD) onLoadMore()
  }, [lastRendered, items.length, rows.length, hasMore, loadingMore, onLoadMore])

  if (!rows.length) {
    return (
      <>
        <div className="list-scroll">
          {emptyNode ?? (
            <div className="empty">
              <span className="empty-title">{emptyTitle}</span>
              {emptySub && <span className="empty-sub">{emptySub}</span>}
            </div>
          )}
        </div>
      </>
    )
  }

  return (
    <>
    <div className="list-scroll" ref={scrollRef} data-selecting={checkedIds.length > 0}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${virtualItems[0]?.start ?? 0}px)`
          }}
        >
          {virtualItems.map((item) => {
            const it = items[item.index]
            if (it.kind === 'header')
              return (
                <div
                  key={item.key}
                  className="row-group"
                  style={{ height: item.index === 0 ? FIRST_GROUP_HEIGHT : GROUP_HEIGHT }}
                >
                  {it.label}
                </div>
              )
            const index = it.index
            const r = rows[index]
            // A thread is unread if any message in it is; flags alone describe
            // only the newest one.
            const unread =
              r.thread_unread === undefined ? isUnread(r.flags) : r.thread_unread > 0
            const isChecked = checked.has(r.id)
            const chips = rowChips(r, labelColors)
            return (
              <div
                key={r.id}
                className="row"
                style={{ height: ROW_HEIGHT }}
                data-selected={index === selectedIndex}
                data-checked={isChecked}
                data-unread={unread}
                // Hover is the cursor (Scape): shortcuts act on the row under
                // the mouse, and one click opens it.
                onMouseMove={(e) => {
                  const p = lastPointer.current
                  if (p.x === e.clientX && p.y === e.clientY) return
                  lastPointer.current = { x: e.clientX, y: e.clientY }
                  if (index === selectedIndex) return
                  hovered.current = true
                  ;(onHover ?? onSelect)(index)
                }}
                onClick={(e) => {
                  // Shift anywhere on the row extends the range, not just on
                  // the checkbox.
                  if (e.shiftKey) {
                    e.preventDefault()
                    onToggleCheck(r.id, index, true)
                    return
                  }
                  onSelect(index)
                  if (onOpen) onOpen(index)
                }}
              >
                {/* The checkbox sits on the unread dot and shows on hover, or
                    on every row once anything is checked. */}
                <span className="row-lead">
                <span className="row-unread-dot" data-read={!unread} />
                <label
                  className="row-check"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onClick={(e) => {
                      e.stopPropagation()
                      // Shift-range: prevent the default toggle, apply range instead.
                      // preventDefault stops the native toggle but React still
                      // fires change, which would undo the row just ranged in.
                      if (e.shiftKey) {
                        e.preventDefault()
                        shiftHandled.current = true
                        onToggleCheck(r.id, index, true)
                      }
                    }}
                    onChange={() => {
                      if (shiftHandled.current) {
                        shiftHandled.current = false
                        return
                      }
                      onToggleCheck(r.id, index, false)
                    }}
                    aria-label="Select message"
                  />
                </label>
                </span>
                <span className="row-sender">
                  {showRecipient
                    ? recipientLabel(r.to_addrs, senderLabel(r.from_name, r.from_addr))
                    : senderLabel(r.from_name, r.from_addr)}
                </span>
                <span className="row-subject">
                  {r.subject || '(no subject)'}
                  {(r.thread_count ?? 1) > 1 && (
                    <span className="row-thread-count">{r.thread_count}</span>
                  )}
                </span>
                <span className="row-snippet">{r.snippet}</span>
                <span className="row-trailing">
                  {r.reminder_fired ? (
                    <Clock className="row-reminder" size={12} strokeWidth={2} aria-label="Reminder" />
                  ) : null}
                  <RowLabels chips={chips} />
                  {/* Always there, starred or not, so labels end at the same edge on every row. */}
                  <span className="row-flag-slot">
                    {isFlagged(r.flags) && (
                      <Star className="row-flag" size={11} strokeWidth={2} fill="currentColor" aria-label="Starred" />
                    )}
                  </span>
                  <span className="row-date">{formatDate(r.remind_at ?? r.date)}</span>
                </span>
              </div>
            )
          })}
        </div>
        {loadingMore && (
          <div className="list-loading" role="status" style={{ top: virtualizer.getTotalSize() - 52 }}>
            <BrandMark size={16} loading label="Loading older mail" />
          </div>
        )}
      </div>
    </div>
    </>
  )
}

/** Three labels or more overlap (Linear) and spread apart on hover. */
const STACK_AT = 3

const toneProps = (c: LabelChipView) => ({
  'data-tone': c.color ? 'custom' : c.tone,
  style: c.color ? ({ '--tone': c.color } as CSSProperties) : undefined
})

/** A row's label chips, in the trailing group before the star and date. */
function RowLabels({ chips }: { chips: LabelChipView[] }) {
  if (!chips.length) return null
  const pills = chips.map((c) => (
    <span key={c.name} className="row-label" {...toneProps(c)}>
      {c.name}
    </span>
  ))
  return (
    <span className={chips.length >= STACK_AT ? 'row-labels row-labels-stack' : 'row-labels'}>{pills}</span>
  )
}
