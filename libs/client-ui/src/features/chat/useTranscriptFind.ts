import {
  createContext,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { CompiledQuery } from '@shared/text-search'
import {
  clearMatches,
  findRanges,
  flashElement,
  isVerticallyVisible,
  observeContent,
  paintMatches,
  revealRange,
} from '@/components/search/domFind'
import { useMatchCursor, type FindState } from '@/components/search/useFind'
import type { ToolState } from './reducer'
import type { TranscriptRow } from './items/transcriptRows'
import {
  createFindCache,
  findTranscriptHits,
  nearestHit,
  segmentPart,
  type TranscriptHit,
} from './transcriptFind'

/** Hits counted before the bar reports "10000+". */
const TRANSCRIPT_FIND_LIMIT = 10_000

/**
 * Frames to wait for a revealed hit to render: the row mounting after the
 * virtualizer scrolls to it, a collapsed run opening, a tool's output
 * expanding. About half a second; past that the row is flashed instead.
 */
const REVEAL_FRAMES = 30

/**
 * A collapsed run animates open (220ms) and the rows above a jump target
 * re-measure as they mount, both of which move a match revealed on its first
 * frame. One more pass after they settle lands it where it ended up.
 */
const RESETTLE_MS = 280

/**
 * What a row has to open to show the current hit, handed only to that row.
 * `nonce` changes on every reveal, so stepping back to a detail the reader
 * has since collapsed opens it again.
 */
export interface FindReveal {
  rowId: string
  segment: string
  nonce: number
}

/**
 * Open what hides the current hit: `open(true)` on every reveal that lands in
 * `part` of this step (`detail`, `thought`), or anywhere in it when `part` is
 * omitted. `open` is a state setter, so the effect runs once per reveal.
 */
export function useOpenOnReveal(
  reveal: FindReveal | undefined,
  open: (value: true) => void,
  part?: 'detail' | 'thought',
): void {
  useEffect(() => {
    if (reveal && (part === undefined || segmentPart(reveal.segment)?.part === part)) open(true)
  }, [reveal, open, part])
}

/**
 * The reveal for the step whose detail is rendering, for a view inside it
 * that folds away some of what find counts (DiffView, past 40 lines). Context
 * rather than a prop, because the views in between have no use for it.
 */
export const DetailRevealContext = createContext<FindReveal | undefined>(undefined)

const NO_HITS = { hits: [] as TranscriptHit[], capped: false }

function hiddenWithin(element: HTMLElement, boundary: HTMLElement): boolean {
  for (
    let node: HTMLElement | null = element;
    node && node !== boundary;
    node = node.parentElement
  ) {
    if (node.getAttribute('aria-hidden') === 'true' || node.hidden) return true
  }
  return false
}

/**
 * The hit's range inside its rendered segment. The DOM count inside a segment
 * can fall short of the data's — a mermaid block drawn as a picture, or a
 * streaming reply, whose body renders a few frames behind its text
 * (`useSmoothedText`) so its newest matches are counted before they paint —
 * and the hit then takes the segment's last rendered match.
 */
function hitRange(segment: HTMLElement, regex: RegExp, hit: TranscriptHit): Range | null {
  return findRanges(segment, regex, hit.ordinal + 1).at(-1) ?? null
}

/** The hit's row and segment, where they are mounted and not hidden. */
function locate(
  root: HTMLElement,
  hit: TranscriptHit,
): { row: HTMLElement | null; segment: HTMLElement | null } {
  for (const row of root.querySelectorAll<HTMLElement>('[data-find-row]')) {
    if (row.dataset.findRow !== hit.rowId) continue
    for (const segment of row.querySelectorAll<HTMLElement>('[data-find-segment]')) {
      if (segment.dataset.findSegment !== hit.segment) continue
      return { row, segment: hiddenWithin(segment, row) ? null : segment }
    }
    return { row, segment: null }
  }
  return { row: null, segment: null }
}

/**
 * Paint every match in the rows that are on screen, the current hit's apart.
 * Returns the hit's range when its segment is rendered.
 */
function paintRendered(
  root: HTMLElement,
  regex: RegExp,
  hit: TranscriptHit | null,
  owner: object,
): Range | null {
  const all: Range[] = []
  let active: Range | null = null
  for (const row of root.querySelectorAll<HTMLElement>('[data-find-row]')) {
    const isTarget = hit !== null && row.dataset.findRow === hit.rowId
    for (const segment of row.querySelectorAll<HTMLElement>('[data-find-segment]')) {
      if (all.length >= TRANSCRIPT_FIND_LIMIT || hiddenWithin(segment, row)) continue
      const ranges = findRanges(segment, regex, TRANSCRIPT_FIND_LIMIT - all.length)
      if (isTarget && segment.dataset.findSegment === hit.segment && ranges.length > 0) {
        active = ranges[Math.min(hit.ordinal, ranges.length - 1)]!
      }
      for (const range of ranges) all.push(range)
    }
  }
  if (all.length > 0) paintMatches(owner, all, active)
  else clearMatches(owner)
  return active
}

/**
 * Find in a session's transcript.
 *
 * Counts come from the row data (`findTranscriptHits`), so "3 of 41" covers
 * the whole session, not the thirty rows the virtualizer has mounted. Paint
 * comes from the DOM, for whatever is mounted. Stepping to a hit scrolls the
 * virtualizer to its row, has the row open whatever hides it (`reveal`), and
 * then scrolls the rendered match into view — releasing the follow-the-stream
 * pin first, or the next token would snap the view back to the tail.
 */
export function useTranscriptFind({
  find,
  rows,
  tools,
  hideThinking,
  workspacePath,
  scrollRef,
  virtualizer,
  releaseFollow,
}: {
  find: FindState
  rows: TranscriptRow[]
  tools: Record<string, ToolState>
  hideThinking: boolean
  workspacePath?: string
  scrollRef: React.RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
  /** Stop following the stream, before a programmatic scroll away from the tail. */
  releaseFollow: () => void
}): {
  total: number
  capped: boolean
  active: number
  step: (delta: number) => void
  reveal: FindReveal | null
} {
  // A streaming reply re-renders the list on every token; the count follows
  // at the pace React can spare rather than on each one.
  const compiled = useDeferredValue(find.compiled)
  const deferredRows = useDeferredValue(rows)
  const deferredTools = useDeferredValue(tools)
  const [cache] = useState(createFindCache)
  const { hits, capped } = useMemo(
    () =>
      compiled.status === 'ready'
        ? findTranscriptHits(
            deferredRows,
            { tools: deferredTools, hideThinking, workspacePath },
            compiled.regex,
            TRANSCRIPT_FIND_LIMIT,
            cache,
          )
        : NO_HITS,
    [compiled, deferredRows, deferredTools, hideThinking, workspacePath, cache],
  )

  const cursor = useMatchCursor(hits.length)
  const { setActive, step: move } = cursor
  const [revealNonce, setRevealNonce] = useState(0)

  // A new query lands on the hit nearest the viewport and reveals it. Until
  // it has, the cursor still holds the last query's index, which means
  // nothing in this one: there is no current hit, so no row opens for it.
  const [landedQuery, setLandedQuery] = useState<CompiledQuery | null>(null)
  const landed = compiled.status !== 'ready' || landedQuery === compiled
  useEffect(() => {
    if (landed) return
    setLandedQuery(compiled)
    const top = scrollRef.current?.scrollTop ?? 0
    const topRow = virtualizer.getVirtualItems().find((item) => item.end > top)?.index ?? 0
    setActive(nearestHit(hits, topRow))
    setRevealNonce((n) => n + 1)
  }, [landed, compiled, hits, scrollRef, virtualizer, setActive])
  const active = landed ? cursor.active : -1
  const hit = hits[active] ?? null

  const step = useCallback(
    (delta: number) => {
      move(delta)
      setRevealNonce((n) => n + 1)
    },
    [move],
  )

  const targetRow = hit?.rowId
  const targetSegment = hit?.segment
  const reveal = useMemo<FindReveal | null>(
    () =>
      targetRow !== undefined && targetSegment !== undefined && revealNonce > 0
        ? { rowId: targetRow, segment: targetSegment, nonce: revealNonce }
        : null,
    [targetRow, targetSegment, revealNonce],
  )

  // The paint pass and the reveal loop run outside React's render, from an
  // observer and animation frames; they read the current query and hit here.
  const regex = compiled.status === 'ready' ? compiled.regex : null
  const latestRef = useRef<{ regex: RegExp | null; hit: TranscriptHit | null }>({
    regex: null,
    hit: null,
  })
  useEffect(() => {
    latestRef.current = { regex, hit }
  })

  const [owner] = useState(() => ({}))
  // What the last full paint was for, so a reveal that finds its hit already
  // painted in the same commit does not paint everything a second time.
  const paintedRef = useRef<{ regex: RegExp; hit: TranscriptHit | null } | null>(null)
  const paint = useCallback(
    (root: HTMLElement, query: RegExp, target: TranscriptHit | null): Range | null => {
      paintedRef.current = { regex: query, hit: target }
      return paintRendered(root, query, target, owner)
    },
    [owner],
  )

  const hitOrdinal = hit?.ordinal
  useEffect(() => {
    const root = scrollRef.current
    if (!root || !regex) {
      paintedRef.current = null
      clearMatches(owner)
      return
    }
    const run = (): void => {
      paint(root, regex, latestRef.current.hit)
    }
    run()
    return observeContent(root, run)
    // The hit's parts, not the object: a streaming pass rebuilds every hit.
  }, [regex, targetRow, targetSegment, hitOrdinal, owner, paint, scrollRef])

  useEffect(() => () => clearMatches(owner), [owner])

  useEffect(() => {
    if (revealNonce === 0) return
    const root = scrollRef.current
    const { regex: query, hit: target } = latestRef.current
    if (!root || !query || !target) return
    let frame = 0
    let handle = 0
    let settle: ReturnType<typeof setTimeout> | undefined
    // The bar closed or the query changed since this reveal began, and the
    // hit it was after went with it.
    const stale = (): boolean => latestRef.current.regex !== query

    const land = (range: Range): void => {
      if (!isVerticallyVisible(range, root)) releaseFollow()
      revealRange(range, root)
    }
    const attempt = (): void => {
      if (stale()) return
      // Only the hit's own segment is searched while it is on its way;
      // everything on screen is painted once, when it arrives.
      const { row, segment } = locate(root, target)
      const found = segment && hitRange(segment, query, target)
      if (found) {
        const painted = paintedRef.current
        const fresh = frame === 0 && painted?.regex === query && painted.hit === target
        land(fresh ? found : (paint(root, query, target) ?? found))
        settle = setTimeout(() => {
          if (stale()) return
          const settled = locate(root, target).segment
          const again = settled && hitRange(settled, query, target)
          if (again && !isVerticallyVisible(again, root)) land(again)
        }, RESETTLE_MS)
        return
      }
      if (!row && frame % 10 === 0) {
        // Not mounted: bring it into the virtualizer's window. Re-issued every
        // few frames, as rows measured on the way change where it sits.
        releaseFollow()
        virtualizer.scrollToIndex(target.row, { align: 'center' })
      }
      if (++frame > REVEAL_FRAMES) {
        const stand = segment ?? row
        if (stand) {
          if (!isVerticallyVisible(stand, root)) releaseFollow()
          revealRange(stand, root)
          flashElement(stand)
        }
        return
      }
      handle = requestAnimationFrame(attempt)
    }
    attempt()
    return () => {
      cancelAnimationFrame(handle)
      clearTimeout(settle)
    }
  }, [revealNonce, owner, paint, releaseFollow, scrollRef, virtualizer])

  return { total: hits.length, capped, active, step, reveal }
}
