import type { MouseEvent } from 'react'
import { ArrowLeft, ArrowRight, Plus, X } from 'lucide-react'

interface Props {
  tabs: { id: number; label: string }[]
  active: number
  canBack: boolean
  canForward: boolean
  onSelect: (index: number) => void
  onClose: (index: number) => void
  onNew: () => void
  onBack: () => void
  onForward: () => void
}

/** Workspace tabs (Scape): ⌘T, ⌘W, ⌘1–9, ⌃Tab; back / forward per tab with ⌘[ / ⌘]. */
export function TabBar({ tabs, active, canBack, canForward, onSelect, onClose, onNew, onBack, onForward }: Props) {
  // Mouse use must not keep focus on a button, or j/k stop working.
  const blur = (e: MouseEvent<HTMLElement>): void => e.currentTarget.blur()
  return (
    <div className="tab-bar">
      <button className="tab-nav" title="Back (⌘[)" aria-label="Back" disabled={!canBack} onClick={(e) => (blur(e), onBack())}>
        <ArrowLeft size={13} strokeWidth={2} />
      </button>
      <button className="tab-nav" title="Forward (⌘])" aria-label="Forward" disabled={!canForward} onClick={(e) => (blur(e), onForward())}>
        <ArrowRight size={13} strokeWidth={2} />
      </button>
      <div className="tab-list" role="tablist">
        {tabs.map((t, i) => (
          <div key={t.id} className="tab" role="tab" aria-selected={i === active} onClick={(e) => (blur(e), onSelect(i))}>
            <span className="tab-label">{t.label}</span>
            {tabs.length > 1 && (
              <button
                className="tab-close"
                aria-label={`Close ${t.label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  blur(e)
                  onClose(i)
                }}
              >
                <X size={11} strokeWidth={2.5} />
              </button>
            )}
          </div>
        ))}
        <button className="tab-nav" title="New tab (⌘T)" aria-label="New tab" onClick={(e) => (blur(e), onNew())}>
          <Plus size={13} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}
