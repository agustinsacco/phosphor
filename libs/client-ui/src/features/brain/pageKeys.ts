import { ignoreShortcut, shortcutOverlayOpen } from '@/lib/shortcutContext'

const TYPING = 'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]'

/**
 * A plain key pressed on the Brain page itself: never typed into a field, never with a
 * modifier, never while a dialog or menu is open. Pages scope their keys with this instead
 * of a window listener.
 */
export function pageKeyTarget(event: React.KeyboardEvent, key: string): boolean {
  if (event.key !== key || event.metaKey || event.ctrlKey || ignoreShortcut(event.nativeEvent))
    return false
  const target = event.target as HTMLElement
  return !target.closest(TYPING) && !target.closest('[data-modal-overlay]') && !shortcutOverlayOpen()
}
