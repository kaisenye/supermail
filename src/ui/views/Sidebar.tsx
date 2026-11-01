import { CheckSquare, Clock, Keyboard, PenSquare, Plus, Search, Settings as SettingsIcon } from 'lucide-react'
import type { AccountSummary } from '../../../electron/preload'
import { AccountSwitcher } from './AccountSwitcher'
import type { Folder } from '../../core/store/types'
import type { FolderRole } from '../../core/store/folderRoles'
import { folderLabel } from '../format'
import { folderIcon } from '../folderIcons'
import type { LabelChipView } from '../labelChips'
import { REMINDERS_VIEW_ID, SEARCH_VIEW_ID } from '../store'

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
  onShortcuts: () => void
  onTasks: () => void
  onSearch: () => void
  onCompose: () => void
  tasksActive: boolean
  openTasks: number
  unread?: Record<number, number>
  /** The Labels section: the Inbox's AI categories with mail, then the inbox's own labels. */
  labels: LabelChipView[]
  /** The label the list is filtered on (a sidebar pick), if any. */
  activeLabel: string | null
  onLabel: (name: string) => void
  /** Settings → AI, where labels are added and edited. */
  onManageLabels: () => void
}

/** Special-use folders first, in the order a human expects them. */
const ORDER: FolderRole[] = ['inbox', 'drafts', 'sent', 'archive', 'all', 'junk', 'trash']

function rank(f: Folder): number {
  const i = f.role ? ORDER.indexOf(f.role) : -1
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
  onShortcuts,
  onTasks,
  onSearch,
  onCompose,
  tasksActive,
  openTasks,
  unread,
  labels,
  activeLabel,
  onLabel,
  onManageLabels
}: Props) {
  // Tasks opens over the current view; while it is open nothing else in the
  // sidebar is the current page.
  const current = tasksActive ? null : activeFolderId
  const sorted = [...folders].sort(
    (a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path)
  )

  return (
    <nav className="sidebar">
      {/* Compose and Search first, above the mailbox (Scape). */}
      <div className="sidebar-actions">
        <button
          className="folder-item sidebar-compose"
          title="Compose (c)"
          onClick={(e) => {
            e.currentTarget.blur()
            onCompose()
          }}
        >
          <PenSquare className="folder-icon" size={15} strokeWidth={1.75} />
          <span className="folder-name">Compose</span>
          <kbd className="folder-key">c</kbd>
        </button>
        <button
          className="folder-item"
          title="Search (/)"
          aria-current={current === SEARCH_VIEW_ID}
          onClick={(e) => {
            e.currentTarget.blur()
            onSearch()
          }}
        >
          <Search className="folder-icon" size={15} strokeWidth={1.75} />
          <span className="folder-name">Search</span>
          <kbd className="folder-key">/</kbd>
        </button>
      </div>
      {/* Renders at any account count: "Add account" lives in this menu, so
          gating it on a second account made the first one impossible to add. */}
      {accounts.length > 0 ? (
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
          const Icon = folderIcon(f)
          const count = unread?.[f.id] ?? 0
          return (
            <li key={f.id}>
              <button
                className="folder-item"
                aria-current={f.id === current}
                onClick={(e) => {
                  // Keep focus on the document so j/k keeps working after a click.
                  e.currentTarget.blur()
                  onSelect(f.id)
                }}
              >
                <Icon className="folder-icon" size={15} strokeWidth={1.75} />
                <span className="folder-name">{folderLabel(f)}</span>
                {count > 0 && <span className="folder-count">{count}</span>}
              </button>
            </li>
          )
        })}
      </ul>

      <div className="sidebar-tasks">
        <button
          className="folder-item"
          aria-current={current === REMINDERS_VIEW_ID}
          onClick={(e) => {
            e.currentTarget.blur()
            onSelect(REMINDERS_VIEW_ID)
          }}
        >
          <Clock className="folder-icon" size={15} strokeWidth={1.75} />
          <span className="folder-name">Reminders</span>
        </button>
        <button
          className="folder-item"
          aria-current={tasksActive}
          onClick={(e) => {
            e.currentTarget.blur()
            onTasks()
          }}
        >
          <CheckSquare className="folder-icon" size={15} strokeWidth={1.75} />
          <span className="folder-name">Tasks</span>
          {openTasks > 0 && <span className="folder-count">{openTasks}</span>}
        </button>
      </div>

      {/* Scape: colour-dot labels near the bottom; each one filters the Inbox. */}
      <div className="sidebar-labels">
        <div className="sidebar-labels-head">
          <span>Labels</span>
          <button
            type="button"
            className="sidebar-labels-add"
            title="Add or edit labels"
            aria-label="Add or edit labels"
            onClick={(e) => {
              e.currentTarget.blur()
              onManageLabels()
            }}
          >
            <Plus size={13} strokeWidth={1.75} />
          </button>
        </div>
        {labels.length === 0 ? (
          <p className="sidebar-labels-empty">Turn on Sort new mail in Settings → AI.</p>
        ) : (
          <ul className="folder-list">
            {labels.map((l) => (
              <li key={`${l.tone}:${l.name}`}>
                <button
                  className="folder-item"
                  aria-current={!tasksActive && activeLabel?.toLowerCase() === l.name.toLowerCase()}
                  onClick={(e) => {
                    e.currentTarget.blur()
                    onLabel(l.name)
                  }}
                >
                  <span className="label-dot" data-tone={l.tone} aria-hidden="true" />
                  <span className="folder-name">{l.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sidebar-footer">
        <button
          className="folder-item"
          title="Settings (⌘,)"
          onClick={(e) => {
            e.currentTarget.blur()
            onSettings()
          }}
        >
          <SettingsIcon className="folder-icon" size={15} strokeWidth={1.75} />
          <span className="folder-name">Settings</span>
        </button>
        <button
          className="sidebar-shortcuts"
          title="Keyboard shortcuts (⌘.)"
          aria-label="Keyboard shortcuts"
          onClick={(e) => {
            e.currentTarget.blur()
            onShortcuts()
          }}
        >
          <Keyboard size={15} strokeWidth={1.75} />
        </button>
      </div>
    </nav>
  )
}
