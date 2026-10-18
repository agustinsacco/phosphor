/** Never reinterpret already-handled keys, IME candidates or AltGr text entry. */
export function ignoreShortcut(event: KeyboardEvent): boolean {
  return event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey
}

/** Data markers cover legacy portals without pretending to add a focus trap. */
export function shortcutOverlayOpen(except?: string): boolean {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[data-modal-overlay], [data-shortcut-overlay], [role="dialog"], [aria-modal="true"]',
    ),
  ].some(
    (el) =>
      (!except || el.dataset.shortcutOverlay !== except) &&
      el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== 'hidden',
  )
}

export function isComposerInput(target: EventTarget | null): boolean {
  return target instanceof Element && target.matches('[data-composer-input]')
}
