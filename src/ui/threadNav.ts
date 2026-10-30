/** i + delta, kept inside 0..n-1. */
export function stepIndex(i: number, delta: number, n: number): number {
  if (n <= 0) return 0
  return Math.max(0, Math.min(n - 1, i + delta))
}

/** ⇧O: expand every message, or back to just the focused one when all are open. */
export function toggleAllExpanded(
  expanded: ReadonlySet<number>,
  ids: number[],
  focusedId: number | null
): Set<number> {
  const allOpen = ids.length > 0 && ids.every((id) => expanded.has(id))
  if (allOpen) return new Set(focusedId !== null ? [focusedId] : [])
  return new Set(ids)
}

/** Tab through links: starts at the first (or the last, going back) and wraps. Null when there are none. */
export function cycleIndex(i: number | null, delta: number, n: number): number | null {
  if (n <= 0) return null
  if (i === null) return delta >= 0 ? 0 : n - 1
  return (((i + delta) % n) + n) % n
}

/** "15 / 201" *(Scape)*: the open conversation's place in the whole view, not just this page. */
export function positionLabel(index: number, page: number, pageSize: number, total: number): string | null {
  if (index < 0 || total <= 0) return null
  return `${page * pageSize + index + 1} / ${total}`
}

export type ActiveTarget<A> =
  | { kind: 'link'; url: string }
  | { kind: 'preview'; attachment: A }
  | { kind: 'confirm'; attachment: A }

/**
 * What ⌘O opens: the link Tab selected, else the focused message's first
 * attachment. A received file never goes straight to the OS default handler
 * on one key: it opens in the sandboxed in-app preview when it has one, and
 * otherwise only after a confirmation naming it.
 */
export function openActiveTarget<A>(
  info: { links: string[]; attachments: A[] } | undefined,
  activeLink: number | null,
  canPreview: (a: A) => boolean
): ActiveTarget<A> | null {
  if (!info) return null
  const url = activeLink !== null ? info.links[activeLink] : undefined
  if (url) return { kind: 'link', url }
  const att = info.attachments[0]
  if (att === undefined) return null
  return canPreview(att) ? { kind: 'preview', attachment: att } : { kind: 'confirm', attachment: att }
}
