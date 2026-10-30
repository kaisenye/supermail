import type { Split } from '../../../electron/preload'
import { CHIPS, type ChipId } from '../chips'

interface Props {
  /** Splits show in the Inbox only; chips show everywhere. */
  splits: Split[] | null
  counts: Record<string, number>
  activeSplit: string
  chip: ChipId | null
  onSplit: (id: string) => void
  onChip: (id: ChipId) => void
}

export function SplitBar({ splits, counts, activeSplit, chip, onSplit, onChip }: Props) {
  return (
    <div className="split-bar">
      {splits && (
        <div className="split-tabs" role="tablist" aria-label="Splits">
          {splits.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === activeSplit}
              onClick={(e) => {
                e.currentTarget.blur()
                onSplit(s.id)
              }}
            >
              {s.name}
              <span className="split-count">{counts[s.id] ?? 0}</span>
            </button>
          ))}
        </div>
      )}
      <div className="split-chips">
        {CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            data-on={chip === c.id}
            onClick={(e) => {
              e.currentTarget.blur()
              onChip(c.id)
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  )
}
