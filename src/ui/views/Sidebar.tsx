import { Settings as SettingsIcon } from 'lucide-react'
import type { AccountSummary } from '../../../electron/preload'
import { AccountSwitcher } from './AccountSwitcher'
import type { Folder } from '../../core/store/types'
import { folderLabel } from '../format'
import { folderIcon } from '../folderIcons'

interface Props {
  email: string | null
  accounts: AccountSummary[]
  activeAccountId: number | null
  onSwitchAccount: (accountId: number) => void
  onAddAccount: () => void
  folders: Folder[]
  activeFolderId: number | null
  onSelect: (id: number) => void
  onSettings: () => void
  unread?: Record<number, number>
}

/** Special-use folders first, in the order a human expects them. */
const ORDER = ['INBOX', 'Drafts', 'Sent Messages', 'Junk', 'Deleted Messages']

function rank(path: string): number {
  const i = ORDER.indexOf(path)
  return i === -1 ? ORDER.length : i
}

export function Sidebar({
  email,
  accounts,
  activeAccountId,
  onSwitchAccount,
  onAddAccount,
  folders,
  activeFolderId,
  onSelect,
  onSettings,
  unread
}: Props) {
  const sorted = [...folders].sort(
    (a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path)
  )

  return (
    <nav className="sidebar">
      {accounts.length > 1 ? (
        <AccountSwitcher
          accounts={accounts}
          activeAccountId={activeAccountId}
          onSwitch={onSwitchAccount}
          onAdd={onAddAccount}
        />
      ) : (
        <div className="sidebar-account" title={email ?? undefined}>
          {email}
        </div>
      )}
      <ul className="folder-list">
        {sorted.map((f) => {
          const Icon = folderIcon(f.path)
          const count = unread?.[f.id] ?? 0
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
                {count > 0 && <span className="folder-count">{count}</span>}
              </button>
            </li>
          )
        })}
      </ul>

      <div className="sidebar-footer">
        <button
          className="folder-item"
          title="Settings (,)"
          onClick={(e) => {
            e.currentTarget.blur()
            onSettings()
          }}
        >
          <SettingsIcon className="folder-icon" size={15} strokeWidth={1.75} />
          <span className="folder-name">Settings</span>
        </button>
      </div>
    </nav>
  )
}
