import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, Info, RotateCcw, X } from 'lucide-react'
import { dismissToast, pauseToasts, resumeToasts, useToasts, type Toast, type ToastKind } from '../toasts'

const ICONS: Record<ToastKind, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
  undo: RotateCcw
}

/** Toasts drawn while stacked; older ones wait behind these. */
const VISIBLE = 3
/** Collapsed: each older card peeks out this far above the one in front. */
const PEEK = 8
/** Expanded (hover): the gap between cards. */
const GAP = 8

/**
 * The toast stack, bottom centre of the content pane. Newest in front; older
 * ones sit just behind it, smaller, and fan out when the pointer is over the
 * stack (which also pauses their timers).
 */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts)
  const [open, setOpen] = useState(false)
  const heights = useRef(new Map<number, number>())
  const [, remeasured] = useState(0)

  // Newest first.
  const order = [...toasts].reverse()
  const live = order.filter((t) => !t.leaving)
  // The last one went while the pointer was over the stack: nothing to hold open.
  useEffect(() => {
    if (!live.length && open) {
      setOpen(false)
      resumeToasts()
    }
  }, [live.length, open])

  let offset = 0
  const placed = order.map((t) => {
    const i = live.indexOf(t)
    const depth = i < 0 ? 0 : i
    const y = open ? -offset : -depth * PEEK
    if (!t.leaving) offset += (heights.current.get(t.id) ?? 52) + GAP
    return { t, depth, y }
  })
  const front = heights.current.get(live[0]?.id ?? -1) ?? 52

  return (
    <section
      className="toaster"
      aria-label="Notifications"
      data-open={open}
      data-empty={!live.length}
      style={{ height: !live.length ? 0 : open ? Math.max(front, offset - GAP) : front }}
      onMouseEnter={() => {
        setOpen(true)
        pauseToasts()
      }}
      onMouseLeave={() => {
        setOpen(false)
        resumeToasts()
      }}
    >
      {placed.map(({ t, depth, y }) => (
        <ToastCard
          key={t.id}
          toast={t}
          hidden={!open && depth >= VISIBLE}
          style={
            {
              '--y': `${y}px`,
              '--s': open ? 1 : 1 - depth * 0.05,
              zIndex: 100 - depth
            } as CSSProperties
          }
          onHeight={(h) => {
            if (heights.current.get(t.id) === h) return
            heights.current.set(t.id, h)
            remeasured((n) => n + 1)
          }}
          behind={!open && depth > 0}
        />
      ))}
    </section>
  )
}

function ToastCard({
  toast: t,
  style,
  hidden,
  behind,
  onHeight
}: {
  toast: Toast
  style: CSSProperties
  hidden: boolean
  behind: boolean
  onHeight: (h: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current) onHeight(ref.current.offsetHeight)
  })
  const Icon = ICONS[t.kind]
  const left = t.endsAt ? Math.max(0, t.endsAt - Date.now()) : null
  return (
    <div
      ref={ref}
      className="toast"
      data-kind={t.kind}
      data-leaving={t.leaving}
      data-hidden={hidden}
      data-behind={behind}
      role={t.kind === 'error' || t.kind === 'warning' ? 'alert' : 'status'}
      style={style}
    >
      <Icon className="toast-icon" size={15} strokeWidth={2} aria-hidden="true" />
      <div className="toast-text">
        <span className="toast-title">{t.title}</span>
        {t.detail && <span className="toast-detail">{t.detail}</span>}
      </div>
      {t.action && (
        <button
          type="button"
          className="toast-action"
          onClick={(e) => {
            e.currentTarget.blur()
            t.action?.run()
          }}
        >
          {t.action.label}
        </button>
      )}
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
        <X size={13} strokeWidth={2} />
      </button>
      {/* Undo's window, draining: the move lands on the server when it empties. */}
      {t.kind === 'undo' && left !== null && (
        <span
          key={t.endsAt}
          className="toast-progress"
          style={{ animationDuration: `${left}ms` } as CSSProperties}
          aria-hidden="true"
        />
      )}
    </div>
  )
}
