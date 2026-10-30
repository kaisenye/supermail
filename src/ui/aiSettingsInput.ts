/**
 * Blur handling for Settings → AI text fields. A blur saves only a real edit:
 * a blank or unchanged field returns null and the view restores the saved value.
 */

/** The new daily budget to save, or null when the field is blank, not a number or unchanged. */
export function budgetEdit(field: string, savedUsd: number): number | null {
  const v = field.trim()
  if (v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n === savedUsd) return null
  return n
}

/** The model to save ('' resets to the default), or null when the field is unchanged. */
export function modelEdit(field: string, shown: string): string | null {
  const v = field.trim()
  return v === shown ? null : v
}
