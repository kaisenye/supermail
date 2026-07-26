interface Props {
  count: number
  allSelected: boolean
  onToggleAll: () => void
  onClear: () => void
  onMarkRead: () => void
  onMarkUnread: () => void
  onStar: () => void
  onArchive: () => void
  onTrash: () => void
}

/** Always shows actions — applies to checked rows, or the focused row if none. */
export function ActionBar({
  count,
  allSelected,
  onToggleAll,
  onClear,
  onMarkRead,
  onMarkUnread,
  onStar,
  onArchive,
  onTrash
}: Props) {
  return (
    <div className="action-bar" role="toolbar" aria-label="Selection actions">
      <label className="action-bar-check">
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = count > 0 && !allSelected
          }}
          onChange={onToggleAll}
          aria-label={allSelected ? 'Deselect all' : 'Select all'}
        />
      </label>
      {count > 0 ? (
        <span className="action-bar-count">{count} selected</span>
      ) : (
        <span className="action-bar-hint">Focused row</span>
      )}
      <div className="action-bar-btns">
        <button type="button" onClick={onMarkRead} title="Mark as read (u toggles)">
          Read
        </button>
        <button type="button" onClick={onMarkUnread} title="Mark as unread (u toggles)">
          Unread
        </button>
        <button type="button" onClick={onStar} title="Star (s)">
          Star
        </button>
        <button type="button" onClick={onArchive} title="Archive (e)">
          Archive
        </button>
        <button type="button" onClick={onTrash} title="Trash (#)">
          Trash
        </button>
        {count > 0 && (
          <button type="button" className="action-bar-clear" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
    </div>
  )
}
