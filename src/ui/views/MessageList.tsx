import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronLeft, ChevronRight, Clock } from 'lucide-react'
import type { MessageListRow } from '../../core/store/types'
import { formatDate, isFlagged, isUnread, recipientLabel, senderLabel } from '../format'
import { withDateGroups, type ListItem } from '../listGroups'

const ROW_HEIGHT = 32
const GROUP_HEIGHT = 24

interface Props {
  rows: MessageListRow[]
  selectedIndex: number
  checkedIds: number[]
  onSelect: (i: number) => void
  onToggleCheck: (id: number, index: number, shiftKey: boolean) => void
  onOpen?: (i: number) => void
  page?: number
  pageSize?: number
  totalRows?: number
  loadingMore?: boolean
  onPage?: (page: number) => void
  emptyTitle?: string
  emptySub?: string
  /** Replaces the empty message entirely (the inbox-zero art). */
  emptyNode?: ReactNode
  /** Sent/Drafts: the sender is always the user, so show the recipient. */
  showRecipient?: boolean
  /** Date headers (Today, Yesterday, …) between runs of rows. */
  groupByDate?: boolean
}

export function MessageList({
  rows,
  selectedIndex,
  checkedIds,
  onSelect,
  onToggleCheck,
  onOpen,
  page = 0,
  pageSize = 50,
  totalRows = 0,
  loadingMore,
  onPage,
  emptyTitle = 'No messages',
  emptySub,
  emptyNode,
  showRecipient = false,
  groupByDate = false
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Set by a shift-click so the change that follows it is ignored. */
  const shiftHandled = useRef(false)
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
    estimateSize: (i) => (items[i]?.kind === 'header' ? GROUP_HEIGHT : ROW_HEIGHT),
    overscan: 12
  })

  useEffect(() => {
    if (rows.length) virtualizer.scrollToIndex(itemOfRow[selectedIndex] ?? 0, { align: 'auto' })
  }, [selectedIndex, rows.length, itemOfRow, virtualizer])

  const virtualItems = virtualizer.getVirtualItems()

  // A new page replaces the rows, so start it at the top rather than wherever
  // the previous page happened to be scrolled.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [page])

  const pager = onPage ? (
    <div className="pager">
      <button
        type="button"
        disabled={page === 0 || loadingMore}
        aria-label="Previous page"
        title="Previous page"
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeft size={14} strokeWidth={2} />
      </button>
      {/* Keep the same text while loading: swapping in "Loading…" resizes the
          pill, and a centred pill then visibly jumps on every page change. */}
      <span className="pager-status" data-loading={!!loadingMore}>
        {totalRows
          ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, totalRows)} of ${totalRows}`
          : `Page ${page + 1}`}
      </span>
      <button
        type="button"
        disabled={loadingMore || (page + 1) * pageSize >= totalRows}
        aria-label="Next page"
        title="Next page"
        onClick={() => onPage(page + 1)}
      >
        <ChevronRight size={14} strokeWidth={2} />
      </button>
    </div>
  ) : null

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
        {pager}
      </>
    )
  }

  return (
    <>
    <div className="list-scroll" ref={scrollRef}>
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
                <div key={item.key} className="row-group" style={{ height: GROUP_HEIGHT }}>
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
            return (
              <div
                key={r.id}
                className="row"
                style={{ height: ROW_HEIGHT }}
                data-selected={index === selectedIndex}
                data-checked={isChecked}
                data-unread={unread}
                onClick={(e) => {
                  // Shift anywhere on the row extends the range, not just on
                  // the checkbox — clicking the row is the usual way to do it.
                  if (e.shiftKey) {
                    e.preventDefault()
                    onToggleCheck(r.id, index, true)
                    return
                  }
                  onSelect(index)
                }}
                onDoubleClick={() => onOpen?.(index)}
              >
                <label
                  className="row-check"
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
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
                <span className="row-unread-dot" data-read={!unread} />
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
                  {isFlagged(r.flags) && (
                    <span className="row-flag" aria-label="Flagged">
                      ●
                    </span>
                  )}
                  <span className="row-date">{formatDate(r.remind_at ?? r.date)}</span>
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
    {pager}
    </>
  )
}
