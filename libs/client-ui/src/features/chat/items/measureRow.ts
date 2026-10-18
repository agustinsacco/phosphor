/**
 * Mounting a row of the virtualized transcript.
 *
 * TanStack's own `measureElement` ref skips a freshly mounted row's
 * synchronous measurement whenever it believes the scroller is scrolling: for
 * 150 ms after any scroll event, and the follow effect scrolls on every frame
 * of a stream. Until the next ResizeObserver frame the row sits at its 40px
 * estimate, so `scrollHeight` grows a frame late and the follow effect's next
 * `scrollTop = scrollHeight` lands on geometry nobody had read yet. On CI's
 * ~1 fps xvfb renderer that frame is a full second, and a wheel that arrived
 * inside it was undone by the late write (the "never fought" smoke test).
 * Whether a mount lands inside the 150 ms window is build timing, which made
 * the failure deterministic per head.
 *
 * `size` is the virtualizer's own measurer. It returns the cached size for a
 * row it has seen before, so a remount is a no-op here and only a first mount
 * is measured early.
 */
export interface RowMeasurer<E> {
  measureElement: (el: E | null) => void
  indexFromElement: (el: E) => number
  resizeItem: (index: number, size: number) => void
}

export function attachRow<E>(
  measurer: RowMeasurer<E>,
  size: (el: E) => number,
  el: E | null,
): void {
  measurer.measureElement(el)
  if (!el) return
  measurer.resizeItem(measurer.indexFromElement(el), size(el))
}
