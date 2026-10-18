import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cacheIndex,
  clearMatches,
  findRanges,
  observeContent,
  paintMatches,
  revealRange,
} from './domFind'
import { useMatchCursor, type FindState } from './useFind'

/** Matches counted before a rendered surface stops and reports "5000+". */
const LIMIT = 5000

function rectOf(range: Range): DOMRect | null {
  // jsdom has no layout, and no Range.getBoundingClientRect at all.
  return typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null
}

/**
 * The first match at or below the top of what the reader is looking at.
 * Matches come in document order, so their rects descend and a binary search
 * reads a dozen of them rather than every one above the fold.
 */
function firstInView(ranges: Range[], root: HTMLElement): number {
  const top = Math.max(root.getBoundingClientRect().top, 0)
  let low = 0
  let high = ranges.length
  while (low < high) {
    const mid = (low + high) >> 1
    const rect = rectOf(ranges[mid]!)
    if (rect !== null && rect.bottom < top) low = mid + 1
    else high = mid
  }
  return low < ranges.length ? low : 0
}

/**
 * Find over a rendered subtree: count every match of the bar's query under
 * `rootRef`, paint them, and scroll the current one into view.
 *
 * The subtree's text is indexed once and re-indexed only when it changes, so
 * a keystroke costs a regex pass, not a walk. It is re-searched as it changes
 * — an artifact can be rewritten by the model while the bar is open — and the
 * cursor holds its index rather than jumping, so a reader stepping through is
 * not yanked. A scroll only happens when the reader asked for one: a new
 * query, or a step.
 */
export function useDomFind({
  find,
  rootRef,
  enabled = true,
}: {
  find: FindState
  rootRef: React.RefObject<HTMLElement | null>
  /** False while the surface shows something unsearchable (an iframe). */
  enabled?: boolean
}): { total: number; capped: boolean; active: number; step: (delta: number) => void } {
  const [owner] = useState(() => ({}))
  const rangesRef = useRef<Range[]>([])
  const indexRef = useRef<ReturnType<typeof cacheIndex> | null>(null)
  const [total, setTotal] = useState(0)
  const [generation, setGeneration] = useState(0)
  const cursor = useMatchCursor(total)
  const { setActive } = cursor
  /** Reveal requests made, and the last one honoured. */
  const [revealRequest, setRevealRequest] = useState(0)
  const revealedRef = useRef(0)
  const { compiled } = find

  // Declared before the search below, so a root that just became searchable
  // has its cache in place when that effect runs in the same commit.
  useEffect(() => {
    const root = rootRef.current
    if (!enabled || !root) return
    const cache = cacheIndex(root)
    indexRef.current = cache
    return () => {
      cache.disconnect()
      indexRef.current = null
    }
  }, [enabled, rootRef])

  useEffect(() => {
    const root = rootRef.current
    if (!enabled || !root || compiled.status !== 'ready') {
      rangesRef.current = []
      setTotal(0)
      setGeneration((n) => n + 1)
      return
    }
    const run = (initial: boolean): void => {
      const ranges = findRanges(root, compiled.regex, LIMIT, indexRef.current?.read())
      rangesRef.current = ranges
      setTotal(ranges.length)
      if (initial) {
        setActive(firstInView(ranges, root))
        setRevealRequest((n) => n + 1)
      }
      setGeneration((n) => n + 1)
    }
    run(true)
    return observeContent(root, () => run(false))
  }, [compiled, enabled, rootRef, setActive])

  const { active } = cursor
  useEffect(() => {
    const ranges = rangesRef.current
    const current = ranges[active] ?? null
    if (ranges.length === 0) clearMatches(owner)
    else paintMatches(owner, ranges, current)
    if (current && revealedRef.current !== revealRequest) {
      revealedRef.current = revealRequest
      revealRange(current, rootRef.current)
    }
  }, [owner, generation, active, revealRequest, rootRef])

  useEffect(() => () => clearMatches(owner), [owner])

  const { step: move } = cursor
  const step = useCallback(
    (delta: number) => {
      move(delta)
      setRevealRequest((n) => n + 1)
    },
    [move],
  )

  return { total, capped: total >= LIMIT, active, step }
}
