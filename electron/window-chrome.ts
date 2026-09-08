import { app, BrowserWindow, nativeTheme } from 'electron'
import { clampUiScale, type ThemePreference } from '@shared/models'
import { getPrefs } from './store'

/**
 * Whether this process should leave its windows unmapped (E2E runs).
 *
 * Playwright drives the renderer over CDP, not through the compositor, so a
 * window that is never shown still loads, lays out, animates and answers
 * geometry queries — it just stops seizing focus from whatever the developer
 * is doing while the suite runs. The always-on-top monitor window was the
 * worst offender.
 *
 * Gated on packaging for the same reason as the other E2E env hooks (an env
 * var must not change a shipped app's behavior — see
 * ipc/pi-session-handlers.ts:piStubPath). `PHOSPHOR_E2E_SHOW=1` opts back in when
 * you want to watch a run.
 *
 * Callers that honor this MUST also set `backgroundThrottling: false`: an
 * unmapped window counts as hidden, and Chromium throttles hidden windows'
 * timers to roughly 1Hz, which would stall every streaming assertion.
 */
export function hideWindowsForE2E(): boolean {
  return (
    !app.isPackaged &&
    Boolean(process.env.PHOSPHOR_TEST_USER_DATA) &&
    process.env.PHOSPHOR_E2E_SHOW !== '1'
  )
}

/**
 * Window Controls Overlay colors (Windows/Linux; macOS draws traffic lights),
 * and the page zoom that backs the "UI scale" preference.
 *
 * The overlay strip is painted by the OS rather than the renderer, so it does
 * not inherit the page theme. Without re-applying it on every theme change,
 * the close/minimize corner stays dark after a switch to the light theme.
 */

/** Must track `--px-bg` / `--px-text-secondary` in src/styles/index.css. */
const CHROME = {
  dark: { color: '#1e1c18', symbolColor: '#aca496' },
  light: { color: '#f7f7f8', symbolColor: '#66666e' },
} as const

/** Must equal the renderer's `h-11` drag strip, or content sits off the controls. */
export const TITLEBAR_HEIGHT = 44

export function overlayFor(theme: ThemePreference): {
  color: string
  symbolColor: string
  height: number
} {
  const resolved = theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : theme
  // The overlay height is device-independent pixels, which page zoom does not
  // touch — but the renderer's 44px drag strip is CSS pixels, which it does.
  // Without scaling here, the OS buttons stop lining up with the header the
  // moment UI scale leaves 100%.
  const height = Math.round(TITLEBAR_HEIGHT * clampUiScale(getPrefs().fonts.uiScale))
  return { ...CHROME[resolved], height }
}

/** No-op on macOS, which has no overlay to restyle. */
export function applyTitleBarOverlay(theme: ThemePreference): void {
  if (process.platform === 'darwin') return
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setTitleBarOverlay(overlayFor(theme))
  }
}

/**
 * "UI scale" is Chromium page zoom, not a root font-size multiplier.
 *
 * A `html { font-size: N% }` only moves `rem`-based lengths, and this UI is
 * written almost entirely in pinned pixels (`text-[12px]`, `width="14"` on
 * every icon) — so the old approach grew the padding and left every glyph and
 * icon the size it was. Page zoom scales the rendered page wholesale, which is
 * what the setting has always claimed to do.
 */
export function applyZoom(uiScale: number): void {
  const factor = clampUiScale(uiScale)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.setZoomFactor(factor)
  }
  applyTitleBarOverlay(getPrefs().theme)
}
