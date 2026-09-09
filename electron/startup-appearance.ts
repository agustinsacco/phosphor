/// <reference lib="dom" />

/** Runs in sandboxed preload, before CSS/fonts/React and async prefs hydration. */
export function applyStartupAppearance(argv: string[]): void {
  const preference = argv.find((arg) => arg.startsWith('--phosphor-theme='))?.split('=')[1]
  const dark =
    preference === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : preference !== 'light'
  const apply = (): boolean => {
    if (!document.documentElement) return false
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    return true
  }
  if (apply()) return
  // The preload can run before <html> exists. Observe only until the parser
  // creates it, rather than waiting for DOMContentLoaded (after first paint).
  const observer = new MutationObserver(() => {
    if (apply()) observer.disconnect()
  })
  observer.observe(document, { childList: true })
}
