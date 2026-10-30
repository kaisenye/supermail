/**
 * Keydown layers for Settings. A key recorder must see Esc before the dialog
 * does, whatever order the listeners were added in. Same-phase listeners on the
 * same target run in registration order, so they sit on different targets:
 * window capture always fires before document capture.
 */

/** Settings closes on Esc. Document capture: still ahead of App's window-bubble hotkeys. */
export function onDialogEscape(onClose: () => void, target: Document = document): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    onClose()
  }
  target.addEventListener('keydown', onKey, true)
  return () => target.removeEventListener('keydown', onKey, true)
}

/** Shortcut recorder: window capture, and it stops the key so nothing below sees it. */
export function onRecordKey(
  handler: (e: KeyboardEvent) => void,
  target: Window = window
): () => void {
  const onKey = (e: KeyboardEvent): void => {
    e.preventDefault()
    e.stopImmediatePropagation()
    handler(e)
  }
  target.addEventListener('keydown', onKey, true)
  return () => target.removeEventListener('keydown', onKey, true)
}
