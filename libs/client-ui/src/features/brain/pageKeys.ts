import { ignoreShortcut, shortcutOverlayOpen } from '@/lib/shortcutContext'

const TYPING =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"]'

/** Plain Brain shortcuts never override text entry, modified keys or an overlay. */
export function pageKeyTarget(event: KeyboardEvent, key: string): boolean {
  if (
    event.key !== key ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    ignoreShortcut(event)
  )
    return false
  const target = event.target
  return (
    target instanceof Element &&
    !target.closest(TYPING) &&
    !target.closest('[data-modal-overlay]') &&
    !shortcutOverlayOpen()
  )
}
