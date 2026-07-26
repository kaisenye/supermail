import type { Folder } from '../../core/store/types'
import { folderLabel } from '../format'
import { folderIcon } from '../folderIcons'

interface Props {
  email: string | null
  folders: Folder[]
  activeFolderId: number | null
  onSelect: (id: number) => void
}

/** Special-use folders first, in the order a human expects them. */
const ORDER = ['INBOX', 'Drafts', 'Sent Messages', 'Junk', 'Deleted Messages']

function rank(path: string): number {
  const i = ORDER.indexOf(path)
  return i === -1 ? ORDER.length : i
}

export function Sidebar({ email, folders, activeFolderId, onSelect }: Props) {
  const sorted = [...folders].sort(
    (a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path)
  )

  return (
    <nav className="sidebar">
      <div className="sidebar-account" title={email ?? undefined}>
        {email}
      </div>
      <ul className="folder-list">
        {sorted.map((f) => {
          const Icon = folderIcon(f.path)
          return (
            <li key={f.id}>
              <button
                className="folder-item"
                aria-current={f.id === activeFolderId}
                onClick={(e) => {
                  // Keep focus on the document so j/k keeps working after a click.
                  e.currentTarget.blur()
                  onSelect(f.id)
                }}
              >
                <Icon className="folder-icon" size={15} strokeWidth={1.75} />
                <span className="folder-name">{folderLabel(f.path, f.name)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
