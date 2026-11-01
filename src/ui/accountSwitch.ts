/**
 * Switching accounts reloads the window (see App's switchAccount). To keep it
 * from flashing, the old inbox fades out (`html[data-switching]`) and, after
 * the reload, the new one fades in (`html[data-arrived]`). sessionStorage
 * carries the hand-off across the reload.
 */
export const SWITCHED_KEY = 'sovo-account-switched'

/** Matches the fade-out transition in app.css. */
export const SWITCH_OUT_MS = 140

/** Runs before the first render: fade in if this load is an account switch. */
export function markArrival(): void {
  try {
    if (!sessionStorage.getItem(SWITCHED_KEY)) return
    sessionStorage.removeItem(SWITCHED_KEY)
  } catch {
    return
  }
  const root = document.documentElement
  root.dataset.arrived = ''
  // Long enough for rows that land a beat after the first paint to fade too.
  setTimeout(() => delete root.dataset.arrived, 700)
}
