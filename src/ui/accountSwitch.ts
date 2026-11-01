/**
 * Switching accounts remounts App with a fresh store (see Root.tsx), under a
 * full-window overlay with the loading mark and the inbox's name: it fades in
 * over the old inbox and fades out once the new one has painted.
 */
export interface SwitchTarget {
  email: string
  name: string | null
}

/** The overlay's fade-in, before the old inbox goes. */
export const SWITCH_IN_MS = 200
/** Shortest the overlay stays up, click to reveal, so the mark reads. */
export const SWITCH_MIN_MS = 650
/** The overlay's fade-out over the new inbox. */
export const SWITCH_OUT_MS = 260
/** Reveal anyway if the new inbox never reports it painted. */
export const SWITCH_MAX_MS = 3000
