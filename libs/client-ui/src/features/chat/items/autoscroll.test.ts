import { describe, expect, it } from 'vitest'
import {
  isFollowKey,
  isScrollBackIntent,
  isScrollBackKey,
  nextPinnedState,
  REPIN_PX,
  tailFloor,
  UNPIN_PX,
} from './autoscroll'

describe('autoscroll pin policy', () => {
  it('keeps the current state when scrollHeight changed', () => {
    // The core regression: the virtualizer re-measuring rows during a stream
    // shrinks scrollHeight, which clamps scrollTop to the bottom and used to
    // re-pin the view and yank the reader down.
    expect(nextPinnedState(false, { distanceFromBottom: 0, heightChanged: true })).toBe(false)
    expect(nextPinnedState(true, { distanceFromBottom: 4000, heightChanged: true })).toBe(true)
  })

  it('never re-pins from geometry, however close to the bottom', () => {
    // A reader clamped to the tail by a collapsing activity group produces
    // exactly this sample, and it used to resume the follow for them.
    expect(nextPinnedState(false, { distanceFromBottom: 0, heightChanged: false })).toBe(false)
    expect(nextPinnedState(false, { distanceFromBottom: REPIN_PX - 1, heightChanged: false })).toBe(
      false,
    )
  })

  it('unpins once the user is clearly reading back', () => {
    expect(nextPinnedState(true, { distanceFromBottom: UNPIN_PX, heightChanged: false })).toBe(
      false,
    )
    expect(nextPinnedState(true, { distanceFromBottom: 5000, heightChanged: false })).toBe(false)
  })

  it('holds state in the dead band between thresholds', () => {
    const middle = (REPIN_PX + UNPIN_PX) / 2
    expect(nextPinnedState(true, { distanceFromBottom: middle, heightChanged: false })).toBe(true)
    expect(nextPinnedState(false, { distanceFromBottom: middle, heightChanged: false })).toBe(false)
  })

  it('resumes the follow from a keyboard gesture', () => {
    // "End" is unconditional; the paging keys only mean follow from the tail,
    // where they would otherwise do nothing.
    expect(isFollowKey('End', 5000)).toBe(true)
    expect(isFollowKey('PageDown', 0)).toBe(true)
    expect(isFollowKey('ArrowDown', REPIN_PX)).toBe(true)
    expect(isFollowKey('PageDown', UNPIN_PX)).toBe(false)
    expect(isFollowKey('ArrowUp', 0)).toBe(false)
  })

  it('reads wheel direction and paging keys as read-back intent', () => {
    expect(isScrollBackIntent(-3)).toBe(true)
    expect(isScrollBackIntent(0)).toBe(false)
    expect(isScrollBackIntent(12)).toBe(false)
    for (const key of ['PageUp', 'ArrowUp', 'Home']) expect(isScrollBackKey(key)).toBe(true)
    for (const key of ['PageDown', 'End', 'a']) expect(isScrollBackKey(key)).toBe(false)
  })

  it('reserves the tail a reader has scrolled away from, and only while unpinned', () => {
    // Following the stream: the transcript is exactly as tall as its content,
    // however much an activity group's collapse just removed.
    expect(tailFloor(true, 4000, 1200)).toBe(1200)

    // Reading back: the settle-time collapse took the content from 4000 to
    // 1200, which would clamp scrollTop and drop the reader at the tail. The
    // floor holds the scroll range open instead.
    expect(tailFloor(false, 4000, 1200)).toBe(4000)

    // Growth past the floor needs no help.
    expect(tailFloor(false, 4000, 6000)).toBe(6000)
  })
})
