import { useEffect, useState } from 'react'
import { escapeRegExp } from '@shared/text-search'
import {
  clearMatches,
  findRanges,
  flashElement,
  observeContent,
  paintMatches,
  revealRange,
} from '@/components/search/domFind'

/**
 * Settings search inside an open tab: the query's terms painted over the
 * live controls, and the chosen result scrolled to and flashed. Painting is
 * the find bar's (CSS Custom Highlight API), so React's DOM is never touched.
 */

/** Matches painted before a tab stops counting; a settings tab never gets near it. */
const PAINT_LIMIT = 500

/** How long a reveal waits for a tab that loads its values over IPC. */
const REVEAL_WAIT_MS = 2000

/** Paint every match of `pattern` under `rootRef`, repainting as the tab renders. */
export function usePaintMatches(
  rootRef: React.RefObject<HTMLElement | null>,
  pattern: RegExp | null,
): void {
  const [owner] = useState(() => ({}))
  useEffect(() => {
    const root = rootRef.current
    if (!root || !pattern) return
    const paint = (): void => paintMatches(owner, findRanges(root, pattern, PAINT_LIMIT), null)
    paint()
    const disconnect = observeContent(root, paint)
    return () => {
      disconnect()
      clearMatches(owner)
    }
  }, [owner, rootRef, pattern])
}

/** The row or heading showing `title`: a title or heading match beats one in prose. */
function findSetting(root: HTMLElement, title: string): HTMLElement | null {
  const ranges = findRanges(root, new RegExp(escapeRegExp(title), 'g'), 50)
  const elements = ranges.map((range) => range.startContainer.parentElement)
  const element =
    elements.find((el) => el?.closest('h1, h2, h3, h4, [data-setting-row]')) ?? elements[0]
  return element?.closest<HTMLElement>('[data-setting-row]') ?? element ?? null
}

/**
 * Scroll to the setting titled `title` and flash it, waiting briefly for it to
 * render. Returns a cancel.
 */
export function revealSetting(root: HTMLElement, title: string): () => void {
  const attempt = (): boolean => {
    const target = findSetting(root, title)
    if (!target) return false
    revealRange(target, root)
    flashElement(target)
    return true
  }
  if (attempt()) return () => undefined
  const disconnect = observeContent(root, () => {
    if (attempt()) cancel()
  })
  const timer = setTimeout(() => cancel(), REVEAL_WAIT_MS)
  function cancel(): void {
    disconnect()
    clearTimeout(timer)
  }
  return cancel
}
