/**
 * Auto-scroll ("follow the stream") policy for the transcript.
 *
 * Deriving "is the user pinned to the bottom?" from geometry alone is what made
 * scrolling up during a stream impossible: the virtualizer keeps correcting its
 * estimated row heights while content arrives, so `scrollHeight` shrinks, the
 * browser clamps `scrollTop`, and the resulting scroll event looks exactly like
 * "the user is at the bottom again" — which re-pinned the view and yanked the
 * reader back down mid-sentence.
 *
 * The fix is to require an explicit gesture to change the pin state. Geometry
 * may still stop the follow — landing far from the tail is unambiguous — but it
 * may never START it: a scroll event that merely reports "you are at the
 * bottom" cannot tell a reader who scrolled there apart from a reader the
 * browser put there by clamping a transcript that just got shorter. Pure so it
 * can be tested without a DOM.
 */

/** Landing this close to the bottom counts as "follow again". */
export const REPIN_PX = 24
/** Scrolling at least this far from the bottom counts as "stop following". */
export const UNPIN_PX = 96

export interface ScrollSample {
  /** `scrollHeight - scrollTop - clientHeight`. */
  distanceFromBottom: number
  /** True when `scrollHeight` differs from the previous sample. */
  heightChanged: boolean
}

/**
 * Next pin state for a scroll event.
 *
 * One-way: it can only ever stop the follow. Re-pinning from geometry is what
 * put a reader back at the tail every time an activity group collapsed —
 * the collapse clamps `scrollTop` to the shorter transcript, and the scroll
 * events that follow the clamp are indistinguishable from a reader who chose
 * the bottom. Following resumes on a gesture instead (`isFollowIntent`,
 * `isFollowKey`, the jump-to-bottom pill, or sending a message).
 */
export function nextPinnedState(current: boolean, sample: ScrollSample): boolean {
  if (sample.heightChanged) return current
  if (sample.distanceFromBottom >= UNPIN_PX) return false
  return current
}

/** Wheel/trackpad gestures that mean "I want to read back". */
export function isScrollBackIntent(deltaY: number): boolean {
  return deltaY < 0
}

/**
 * Wheel-down at (or near) the bottom means "follow again".
 *
 * The geometry path can miss this re-pin: if the landing scroll sample
 * coincides with a stream-driven height change it is held as layout, and once
 * the user rests at the bottom no further scroll events arrive. The gesture
 * itself is unambiguous, so honor it directly.
 */
export function isFollowIntent(deltaY: number, distanceFromBottom: number): boolean {
  return deltaY > 0 && distanceFromBottom <= REPIN_PX
}

/** Keys that move the viewport away from the tail. */
const SCROLL_BACK_KEYS = new Set(['PageUp', 'ArrowUp', 'Home'])

export function isScrollBackKey(key: string): boolean {
  return SCROLL_BACK_KEYS.has(key)
}

/** "Take me to the tail", whatever the reader is looking at now. */
const TO_TAIL_KEYS = new Set(['End'])
/** Moves toward the tail, so it means "follow again" only from the tail. */
const TOWARD_TAIL_KEYS = new Set(['PageDown', 'ArrowDown', ' ', 'Spacebar'])

/**
 * Keyboard equivalent of `isFollowIntent`. Geometry alone no longer re-pins,
 * so every way a reader can ask to follow again has to be a gesture — and
 * paging back down to the tail is one of them.
 */
export function isFollowKey(key: string, distanceFromBottom: number): boolean {
  if (TO_TAIL_KEYS.has(key)) return true
  return TOWARD_TAIL_KEYS.has(key) && distanceFromBottom <= REPIN_PX
}

/**
 * Height floor for the transcript's content box while the reader is unpinned.
 *
 * Unpinning stops us from scrolling the reader down, but it does nothing about
 * the transcript getting SHORTER underneath them. It does, routinely: an
 * activity group is expanded while it runs and collapses the moment it
 * settles, which removes hundreds of pixels in one commit. The browser then
 * clamps `scrollTop` to the new maximum and the reader lands back at the tail
 * — the "it sticks to the bottom" complaint, with the jump-to-bottom pill
 * still showing because the pin state never changed.
 *
 * Measured before this existed (e2e probe, `manyitems`): reading back to
 * scrollTop 324 of 444, the run settled and the reader was moved to 0.
 *
 * So while unpinned, the content box may not shrink above the floor the
 * reader set when they stopped following. The reserved strip is empty space
 * below the last row, off screen by construction. The caller only ever lowers
 * the floor (scrolling further back) and drops it on re-pin — raising it again
 * on the way down would make the tail recede ahead of the reader forever.
 */
export function tailFloor(pinned: boolean, floor: number, contentHeight: number): number {
  if (pinned) return contentHeight
  return Math.max(contentHeight, floor)
}
