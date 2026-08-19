import { useEffect, useRef, useState } from 'react'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import type { AccountSummary } from '../../../electron/preload'

interface Props {
  accounts: AccountSummary[]
  activeAccountId: number | null
  onSwitch: (accountId: number) => void
  onAdd: () => void
}

/**
 * Also the only route to "Add account", so it renders with a single account
 * too — the affordance shifts from switching to adding.
 */
export function AccountSwitcher({ accounts, activeAccountId, onSwitch, onAdd }: Props) {
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
            <button
              key={a.accountId}
              role="menuitem"
              className="account-menu-item"
              onClick={() => {
                setOpen(false)
                if (a.accountId !== activeAccountId) onSwitch(a.accountId)
              }}
            >
              <span className="account-menu-check">
                {a.accountId === activeAccountId && <Check size={12} strokeWidth={2.5} />}
              </span>
              <span className="account-menu-text">
                <span className="account-menu-email">{a.email}</span>
                {a.name && <span className="account-menu-name">{a.name}</span>}
              </span>
            </button>
          ))}
          <button
            role="menuitem"
            className="account-menu-item account-menu-add"
            onClick={() => {
              setOpen(false)
              onAdd()
            }}
          >
            <span className="account-menu-check">
              <Plus size={12} strokeWidth={2} />
            </span>
            <span className="account-menu-text">Add account…</span>
          </button>
        </div>
      )}
    </div>
  )
}
