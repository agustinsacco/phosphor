import type { PhosphorPlatform } from '@shared/ipc'

export type ClipboardAction = 'copy' | 'paste'

/** The subset of a KeyboardEvent this needs — so tests can pass plain objects. */
export type ClipboardKeyEvent = Pick<
  KeyboardEvent,
  'type' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'
>

/**
 * Which clipboard action a key event asks for, if any.
 *
 * xterm ships no copy binding: its selection is painted rows, not a DOM
 * selection, so the browser's own Cmd/Ctrl+C fires a `copy` event with nothing
 * in it. Ctrl+C also has to keep meaning SIGINT on Windows/Linux, which is why
 * every terminal emulator there puts copy on Ctrl+Shift+C (GNOME Terminal,
 * Windows Terminal, VS Code); macOS keeps ⌘C/⌘V, where Cmd is free because the
 * key evaluator never turns Cmd chords into input.
 *
 * Matches on `event.code`, not `event.key`: with Shift held `key` is 'C' rather
 * than 'c', and on a non-US layout it may be neither (same reason
 * `useGlobalShortcuts` matches codes).
 */
/** The modifier half of that chord, for `formatShortcut` labels. */
export function clipboardModifiers(platform: PhosphorPlatform): string[] {
  return platform === 'darwin' ? ['mod'] : ['mod', 'shift']
}

export function clipboardActionFor(
  event: ClipboardKeyEvent,
  platform: PhosphorPlatform,
): ClipboardAction | null {
  if (event.type !== 'keydown' || event.altKey) return null
  const held =
    platform === 'darwin'
      ? event.metaKey && !event.ctrlKey && !event.shiftKey
      : event.ctrlKey && event.shiftKey && !event.metaKey
  if (!held) return null
  if (event.code === 'KeyC') return 'copy'
  if (event.code === 'KeyV') return 'paste'
  return null
}
