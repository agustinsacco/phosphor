import type { PidexPlatform } from '@shared/ipc'

/**
 * Platform-correct keyboard-shortcut labels.
 *
 * Handlers own their chord/scope rules; these helpers only render labels. macOS spells shortcuts
 * as glyphs run together (⌘⇧E); Windows and Linux name the keys and separate
 * them (Ctrl+Shift+E).
 */

export type Modifier = 'mod' | 'shift' | 'alt' | 'ctrl'

/**
 * `mod` is Command on macOS and Control everywhere else; `ctrl` is Control on
 * every platform, for the handful of bindings pidex inherits from Claude
 * Code's terminal UI (⌃O) where Control is the key regardless of OS.
 */
const GLYPHS: Record<Modifier, string> = { mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃' }
const NAMES: Record<Modifier, string> = {
  mod: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  ctrl: 'Ctrl',
}

const MODIFIERS = new Set<string>(['mod', 'shift', 'alt', 'ctrl'])

function isModifier(part: string): part is Modifier {
  return MODIFIERS.has(part)
}

/** Pure form, for tests and for callers that already know the platform. */
export function formatShortcutFor(platform: PidexPlatform, parts: readonly string[]): string {
  const mac = platform === 'darwin'
  const table = mac ? GLYPHS : NAMES
  const rendered = parts.map((part) => (isModifier(part) ? table[part] : part))
  return rendered.join(mac ? '' : '+')
}

/**
 * The host platform. Falls back to 'linux' rather than throwing: this runs
 * during first paint, and a missing bridge should degrade to a spelled-out
 * label, never a blank one.
 */
export function hostPlatform(): PidexPlatform {
  return typeof window === 'undefined' ? 'linux' : (window.pidex?.platform ?? 'linux')
}

/** `formatShortcut('mod', 'shift', 'E')` → `⌘⇧E` on macOS, `Ctrl+Shift+E` elsewhere. */
export function formatShortcut(...parts: string[]): string {
  return formatShortcutFor(hostPlatform(), parts)
}
