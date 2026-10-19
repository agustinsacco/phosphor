import type { ThemePreference } from '@shared/models'

/** Shared by native preferences and the browser's pre-session startup surface. */
export function resolveTheme(theme: ThemePreference): 'light' | 'dark' {
  if (theme !== 'system') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(resolved: 'light' | 'dark'): void {
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.style.colorScheme = resolved
}
