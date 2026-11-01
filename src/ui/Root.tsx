import { useCallback, useEffect, useRef, useState } from 'react'
import App from './App.js'
import { useStore } from './store'
import { SWITCH_IN_MS, SWITCH_MAX_MS, SWITCH_MIN_MS, SWITCH_OUT_MS, type SwitchTarget } from './accountSwitch'
import { SwitchOverlay } from './views/SwitchOverlay'

type Switching = SwitchTarget & { startedAt: number; phase: 'in' | 'held' | 'out' }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Owns the account switch. App is keyed by a generation: a switch resets the
 * store and bumps it, so the new account boots in a fresh App exactly as a
 * launch would, while the overlay above it stays put. A window reload did the
 * same job but blanked the page (styles, theme) for a moment.
 */
export function Root() {
  const [gen, setGen] = useState(0)
  const [switching, setSwitching] = useState<Switching | null>(null)
  const [painted, setPainted] = useState(false)
  const busy = useRef(false)

  const onSwitchAccount = useCallback(async (accountId: number, target: SwitchTarget) => {
    if (busy.current) return
    busy.current = true
    const startedAt = Date.now()
    setSwitching({ ...target, startedAt, phase: 'in' })
    try {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const [res] = await Promise.all([window.api.accountSetActive(accountId), reduced ? undefined : sleep(SWITCH_IN_MS)])
      if (!res.ok) {
        setSwitching(null)
        return
      }
      useStore.setState(useStore.getInitialState(), true)
      setPainted(false)
      setGen((g) => g + 1)
      setSwitching((s) => (s ? { ...s, phase: 'held' } : s))
    } finally {
      busy.current = false
    }
  }, [])

  const onPainted = useCallback(() => setPainted(true), [])

  // Held until the new inbox paints (or SWITCH_MAX_MS), and at least
  // SWITCH_MIN_MS from the click; then it fades out.
  useEffect(() => {
    if (switching?.phase !== 'held') return undefined
    const reveal = (): void => setSwitching((s) => (s ? { ...s, phase: 'out' } : s))
    const cap = setTimeout(reveal, Math.max(0, switching.startedAt + SWITCH_MAX_MS - Date.now()))
    const min = painted ? setTimeout(reveal, Math.max(0, switching.startedAt + SWITCH_MIN_MS - Date.now())) : undefined
    return () => {
      clearTimeout(cap)
      clearTimeout(min)
    }
  }, [switching?.phase, switching?.startedAt, painted])

  useEffect(() => {
    if (switching?.phase !== 'out') return undefined
    const t = setTimeout(() => setSwitching(null), SWITCH_OUT_MS)
    return () => clearTimeout(t)
  }, [switching?.phase])

  return (
    <>
      <App key={gen} onSwitchAccount={onSwitchAccount} onPainted={onPainted} />
      {switching && <SwitchOverlay {...switching} />}
    </>
  )
}
