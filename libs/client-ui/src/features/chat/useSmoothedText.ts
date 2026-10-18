import { useEffect, useRef, useState } from 'react'
import { advanceReveal, sliceAtCodePoint, type RevealState } from '@/lib/textReveal'

/**
 * The visible slice of a streaming text block, paced by `advanceReveal`.
 *
 * Altitude matters more than the math here. This lives in the LEAF component
 * (one prose block), holds its progress in local state, and never writes to
 * the chat store — so a 30Hz reveal re-renders one `<Markdown>` while
 * `buildTranscriptRows` and the rest of the transcript stay untouched. Pacing
 * in the store would re-run the whole transcript build per tick, which is the
 * exact per-token rebuild the perf backlog (F3) exists to kill.
 *
 * Three deliberate behaviors:
 *
 * - **Mounting shows everything already present.** Only text that arrives
 *   after mount animates. Hydrated history must not replay a typewriter, and
 *   the virtualizer re-mounts rows that scroll back in mid-stream — a replay
 *   there would re-type a whole answer the reader already saw.
 * - **Settling drains fast instead of snapping.** When `streaming` flips off
 *   with backlog remaining, the tail finishes on the fast schedule; a snap
 *   would end every smooth turn with one final pop.
 * - **Ticks are capped at ~30Hz.** Each committed tick re-parses the block's
 *   markdown (ReactMarkdown + GFM + math), so 60Hz would double that cost
 *   for smoothness the eye cannot see at 2-3 characters per frame.
 */
const TICK_MS = 33

export function useSmoothedText(text: string, streaming: boolean): string {
  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // Everything already present at mount is shown, not replayed.
  const stateRef = useRef<RevealState>({ visible: text.length, lastTick: 0 })
  const [visible, setVisible] = useState(text.length)
  const skip = reduceMotion || !streaming ? text.length : null

  useEffect(() => {
    // Reduced motion means no reveal at all, not a faster one.
    if (reduceMotion) {
      stateRef.current.visible = text.length
      return
    }
    // Not animating: keep the ref pinned to the tail so a later stream
    // (a follow-up turn re-opening this block) starts from here, not from 0.
    if (skip !== null && stateRef.current.visible >= text.length) {
      stateRef.current.visible = text.length
      return
    }

    let frame = 0
    let backstop: ReturnType<typeof setTimeout> | undefined
    let lastCommit = 0
    stateRef.current.lastTick = performance.now()

    const tick = (now: number): void => {
      clearTimeout(backstop)
      cancelAnimationFrame(frame)
      stateRef.current = advanceReveal(stateRef.current, text.length, now, streaming)
      if (now - lastCommit >= TICK_MS) {
        lastCommit = now
        setVisible(stateRef.current.visible)
      }
      if (stateRef.current.visible < text.length) {
        schedule()
      } else {
        setVisible(text.length)
      }
    }
    // rAF for smoothness, a timeout as the backstop. In a hidden window
    // (background tab, the e2e suite's never-shown windows) rAF never fires,
    // and an rAF-only loop left settled text stuck at a partial slice
    // forever. Throttled timers still tick — about once a second — and
    // `advanceReveal` is dt-based, so each starved tick drains a full
    // second's worth; the text always completes, it just isn't animated
    // where nobody can see it anyway.
    const schedule = (): void => {
      frame = requestAnimationFrame(tick)
      backstop = setTimeout(() => tick(performance.now()), 250)
    }
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(backstop)
    }
  }, [text, streaming, skip, reduceMotion])

  if (reduceMotion) return text
  if (skip !== null && stateRef.current.visible >= text.length) return text
  return sliceAtCodePoint(text, visible)
}
