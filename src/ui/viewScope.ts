import type { ChipId } from './chips'

/** What the list on screen is showing: account, folder (or Reminders), split and chip. */
export interface ViewKey {
  email: string | null
  folderId: number | null
  splitId: string
  chip: ChipId | null
}

export function viewKey(s: {
  email: string | null
  activeFolderId: number | null
  splitId: string
  chip: ChipId | null
}): ViewKey {
  return { email: s.email, folderId: s.activeFolderId, splitId: s.splitId, chip: s.chip }
}

export function sameView(a: ViewKey, b: ViewKey): boolean {
  return a.email === b.email && a.folderId === b.folderId && a.splitId === b.splitId && a.chip === b.chip
}

/**
 * How an undo repaints the list. Saved rows are spliced back only into the view
 * they were taken from; anywhere else they would land in the wrong list (and
 * duplicate rows the new view already holds), so that list is re-read instead.
 */
export function undoRepaint(origin: ViewKey, current: ViewKey): 'restore' | 'reload' {
  return sameView(origin, current) ? 'restore' : 'reload'
}

/**
 * What Done does in a view. A Reminders row is the reminder's keyed message,
 * which for remind-on-send is the user's Sent copy: moving that to Archive
 * would file away Sent mail and leave the reminder pending. There, Done
 * dismisses the reminder instead.
 */
export function doneAction(folderId: number | null, remindersViewId: number): 'dismissReminder' | 'move' {
  return folderId === remindersViewId ? 'dismissReminder' : 'move'
}

/**
 * What an IDLE push syncs. A push from the account on screen (or into the
 * unified inbox, whose refresh syncs every account) refreshes the view; a push
 * from another account syncs that account, since syncing the active one would
 * leave its mail waiting for the 60 s poll.
 */
export function pushSyncTarget(
  pushEmail: string | undefined,
  view: { email: string | null; activeFolderId: number | null },
  unifiedViewId: number
): 'view' | 'account' {
  if (!pushEmail || view.activeFolderId === unifiedViewId) return 'view'
  return pushEmail.toLowerCase() === view.email?.toLowerCase() ? 'view' : 'account'
}
