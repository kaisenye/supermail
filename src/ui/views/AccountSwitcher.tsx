import { useEffect, useRef, useState } from 'react'
import { ChevronsUpDown, Plus, RefreshCw, User } from 'lucide-react'
import type { AccountSummary } from '../../../electron/preload'

interface Props {
  accounts: AccountSummary[]
  activeAccountId: number | null
  onSwitch: (accountId: number) => void
  onAdd: () => void
  /** Sign an OAuth inbox in again, now asking for its name and photo. */
  onReconnect: (account: AccountSummary) => void
}

/** The inbox's photo from its provider, or a grey person when there is none. */
export function Avatar({ src, size }: { src?: string | null; size: number }) {
  return (
    <span className="account-avatar" style={{ width: size, height: size }} aria-hidden="true">
      {src ? <img src={src} alt="" draggable={false} /> : <User size={Math.round(size * 0.62)} strokeWidth={2} />}
    </span>
  )
}

/**
 * Also the only route to "Add account", so it renders with a single account
 * too — the affordance shifts from switching to adding.
 */
export function AccountSwitcher({ accounts, activeAccountId, onSwitch, onAdd, onReconnect }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = accounts.find((a) => a.accountId === activeAccountId) ?? accounts[0]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!active) return null

  return (
    <div className="sidebar-account-wrap" ref={ref}>
      <button
        className="sidebar-account"
        title={active.email}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar src={active.avatar} size={18} />
        <span className="sidebar-account-email">{active.email}</span>
        {accounts.length > 1 ? (
          <ChevronsUpDown size={12} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Plus size={12} strokeWidth={2} aria-hidden="true" />
        )}
      </button>

      {open && (
        <div className="account-menu" role="menu">
          {accounts.map((a) => (
            <div key={a.accountId} role="none">
              {/* The open inbox wears the accent background instead of a check mark. */}
              <button
                role="menuitemradio"
                aria-checked={a.accountId === activeAccountId}
                className="account-menu-item"
                onClick={() => {
                  setOpen(false)
                  if (a.accountId !== activeAccountId) onSwitch(a.accountId)
                }}
              >
                <Avatar src={a.avatar} size={22} />
                <span className="account-menu-text">
                  <span className="account-menu-email">{a.name ?? a.email}</span>
                  {a.name && <span className="account-menu-name">{a.email}</span>}
                </span>
              </button>
              {/* Signed in before Sovo asked for a name and photo: one reconnect loads them. */}
              {a.needsProfile && (
                <button
                  role="menuitem"
                  className="account-menu-item account-menu-reconnect"
                  onClick={() => {
                    setOpen(false)
                    onReconnect(a)
                  }}
                >
                  <span className="account-menu-icon">
                    <RefreshCw size={12} strokeWidth={2} />
                  </span>
                  <span className="account-menu-text">Reconnect to load name and photo</span>
                </button>
              )}
            </div>
          ))}
          <button
            role="menuitem"
            className="account-menu-item account-menu-add"
            onClick={() => {
              setOpen(false)
              onAdd()
            }}
          >
            <span className="account-menu-icon">
              <Plus size={12} strokeWidth={2} />
            </span>
            <span className="account-menu-text">Add account…</span>
          </button>
        </div>
      )}
    </div>
  )
}
