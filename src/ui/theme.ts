export type Theme = 'system' | 'light' | 'dark'

export function isTheme(v: string | undefined): v is Theme {
  return v === 'system' || v === 'light' || v === 'dark'
}

/**
 * tokens.css keys off `data-theme`, falling back to a prefers-color-scheme
 * query when the attribute is absent — so "system" means remove it, not set it.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
}

/** Resolved dark/light right now, for the sandboxed frames that inline colors. */
export function isDark(): boolean {
  const attr = document.documentElement.dataset.theme
  if (attr) return attr === 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}
