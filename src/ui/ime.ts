/**
 * True while an IME composition owns the key — e.g. the Enter that confirms a Pinyin
 * candidate. Chromium still sends it as keydown 'Enter', with isComposing set (or keyCode
 * 229 on some paths), so a handler that acts on Enter must ignore it.
 */
export function isImeKey(e: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return e.isComposing || e.keyCode === 229
}
