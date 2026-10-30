/** The split to keep showing after the list changes: the current one, or All if it is gone. */
export function resolveSplitId(list: { id: string }[], current: string): string {
  return list.some((s) => s.id === current) ? current : 'all'
}

/** Tab / Shift+Tab. A current id missing from the list counts as the first split. */
export function nextSplitId(list: { id: string }[], current: string, delta: number): string | null {
  if (!list.length) return null
  const i = Math.max(0, list.findIndex((s) => s.id === current))
  return list[(((i + delta) % list.length) + list.length) % list.length].id
}
