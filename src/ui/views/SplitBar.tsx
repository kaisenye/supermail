import { Inbox, X } from 'lucide-react'
import type { Split } from '../../../electron/preload'
import { CHIPS, type ChipId } from '../chips'

interface Props {
  /** Splits apply in the Inbox only; chips everywhere. */
  splits: Split[] | null
  activeSplit: string
  chip: ChipId | null
  onChip: (id: ChipId) => void
  /** Back to everything: no chip, and the All split. */
  onClear: () => void
}

/**
 * Scape's filter row. The round button is "All" while nothing is filtered and
 * turns into × to clear once something is; then the pills. A split other than
 * All (Tab cycles them) shows as an extra active pill so it is never hidden.
 */
export function SplitBar({ splits, activeSplit, chip, onChip, onClear }: Props) {
  const split = splits?.find((s) => s.id === activeSplit && s.id !== 'all')
  const filtered = !!chip || !!split

  return (
    <div className="split-bar">
      <button
        type="button"
        className="split-all"
        data-on={!filtered}
        aria-label={filtered ? 'Clear filter' : 'All mail'}
        title={filtered ? 'Clear filter' : 'All mail'}
        onClick={(e) => {
          e.currentTarget.blur()
          if (filtered) onClear()
        }}
      >
        {filtered ? <X size={14} strokeWidth={1.75} /> : <Inbox size={14} strokeWidth={1.75} />}
      </button>
      {split && (
        <button type="button" className="split-pill" data-on="true" onClick={onClear} title="Split (Tab cycles)">
          {split.name}
        </button>
      )}
      {CHIPS.map((c) => (
        <button
          key={c.id}
          type="button"
          className="split-pill"
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
  )
}
