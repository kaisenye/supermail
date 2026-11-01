import { BrandMark } from './BrandMark'
import type { SwitchTarget } from '../accountSwitch'

interface Props extends SwitchTarget {
  /** Date.now() at the click. */
  startedAt: number
  /** in: fading in over the old inbox; held: while the new one boots; out: revealing it. */
  phase: 'in' | 'held' | 'out'
}

/**
 * Covers an account switch: the mark's loading loop, centred, over the
 * inbox being opened.
 */
export function SwitchOverlay({ email, name, phase }: Props) {
  return (
    <div className="switch-overlay" data-phase={phase} role="status" aria-live="polite">
      <div className="switch-card">
        <BrandMark size={56} loading label="Loading" />
        <span className="switch-label">Opening</span>
        <span className="switch-name">{name || email}</span>
        {name && <span className="switch-email">{email}</span>}
      </div>
    </div>
  )
}
