import { useLayoutEffect, type RefObject } from 'react'

/**
 * Compact composer cap. The visible line count depends on font metrics/zoom;
 * expanded composers instead use a viewport-bounded CSS min/max height.
 */
export const COMPOSER_MAX_HEIGHT = 240

/**
 * Auto-grow a textarea to fit its *visible* content, capped at `maxHeight` px.
 * Beyond the cap the textarea scrolls internally.
 *
 * The `rows` attribute (kept on the element as a floor) only tracks explicit
 * newlines — a long line that soft-wraps keeps the box at `rows` lines and
 * scrolls inside it, so the box never grows with what the user actually sees.
 * Measuring `scrollHeight` instead tracks the wrapped lines.
 *
 * A ResizeObserver keeps sizing correct when the column width changes (pane
 * or window resize) without any text change, one frame later.
 */
export function useAutoResizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  text: string,
  maxHeight: number,
): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const resize = (): void => {
      // Reset to content height so scrollHeight measures all wrapped lines,
      // then clamp: the floor is the natural `rows` height, the ceiling the cap.
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    }
    resize()

    // Resizing the observed element inside its own callback is a resize loop
    // the browser reports as an error (WebKit raises it as a page error), so
    // the re-measure waits for the next frame.
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(resize)
    })
    observer.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [ref, text, maxHeight])
}
