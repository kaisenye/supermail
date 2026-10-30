/** Seconds the user can pick in Settings (Scape offers the same idea). */
export const UNDO_CHOICES_S = [3, 5, 10, 20] as const
export const DEFAULT_UNDO_S = 3

/**
 * The one undo window. Main holds IMAP moves and immediate sends for this long,
 * and the renderer's toast and `z` use the hold main reports back, so the two
 * can never disagree.
 */
export function undoWindowMs(settings: Record<string, string | undefined>): number {
  const n = Number(settings.undo_seconds)
  return (UNDO_CHOICES_S as readonly number[]).includes(n) ? n * 1000 : DEFAULT_UNDO_S * 1000
}
