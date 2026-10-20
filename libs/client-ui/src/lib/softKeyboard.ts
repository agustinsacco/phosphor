/**
 * Whether the person types on a phone's on-screen keyboard.
 *
 * A touch-first device with no hover is the signal; the viewport width is not,
 * because a wide tablet still types on glass and a narrow Desktop window does
 * not. There, Return adds a line (as in the Claude, ChatGPT and Gemini apps)
 * and a send closes the keyboard so the reply has the screen.
 */
export function softKeyboard(): boolean {
  return (
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(hover: none) and (pointer: coarse)').matches
  )
}

/** ⇧Enter anywhere, and plain Return on a soft keyboard, add a line instead of sending. */
export function enterAddsLine(
  event: Pick<KeyboardEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>,
): boolean {
  return event.shiftKey || (!event.metaKey && !event.ctrlKey && softKeyboard())
}

/** After a send: hand the screen back to the conversation on a phone. */
export function closeSoftKeyboard(field: HTMLElement | null | undefined): void {
  if (softKeyboard()) field?.blur()
}
