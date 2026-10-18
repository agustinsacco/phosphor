import { useEffect, useRef } from 'react'
import { selectionSeed } from './useFind'

/**
 * Where ⌘F goes.
 *
 * Every searchable surface registers the element it covers and how to open
 * its bar. ⌘F then opens the innermost surface around focus — or around the
 * last click, when that click landed on something that does not take focus
 * (most of a rendered artifact). Nothing matched means the reader is in the
 * composer or the chrome around it, so the transcript, registered as the
 * fallback, takes it.
 *
 * Monaco and xterm are not registered: both are editable targets the global
 * handler skips, and each binds ⌘F to its own find widget.
 */
export interface FindTarget {
  element: () => HTMLElement | null
  open: (seed?: string) => void
  /** Takes ⌘F when no other surface is around focus. */
  fallback?: boolean
}

const targets = new Set<FindTarget>()
let lastPointerTarget: Element | null = null
let listening = false

function rememberPointer(event: PointerEvent): void {
  lastPointerTarget = event.target instanceof Element ? event.target : null
}

function registerFindTarget(target: FindTarget): () => void {
  if (!listening && typeof window !== 'undefined') {
    window.addEventListener('pointerdown', rememberPointer, true)
    listening = true
  }
  targets.add(target)
  return () => {
    targets.delete(target)
  }
}

/** Where `visible` probes an element: its centre, and a point in from each corner. */
const PROBES: [number, number][] = [
  [0.5, 0.5],
  [0.1, 0.1],
  [0.9, 0.1],
  [0.1, 0.9],
  [0.9, 0.9],
]

/**
 * On screen, not merely laid out. A global page and an expanded pane cover the
 * chat without unmounting it, and a bar opened under them would take focus
 * where no one can see it type. Any probe landing inside the element counts,
 * so a toast or a floating button over part of it does not.
 */
function visible(element: HTMLElement): boolean {
  if (!element.isConnected || element.getClientRects().length === 0) return false
  // jsdom: no hit-testing.
  if (typeof document.elementFromPoint !== 'function') return true
  const box = element.getBoundingClientRect()
  const left = Math.max(box.left, 0)
  const top = Math.max(box.top, 0)
  const right = Math.min(box.right, window.innerWidth)
  const bottom = Math.min(box.bottom, window.innerHeight)
  if (right <= left || bottom <= top) return false
  return PROBES.some(([x, y]) => {
    const hit = document.elementFromPoint(left + (right - left) * x, top + (bottom - top) * y)
    return hit !== null && element.contains(hit)
  })
}

/** The surface ⌘F should open, or null when none is on screen. */
function findTargetFor(anchor: Element | null): FindTarget | null {
  let best: { target: FindTarget; element: HTMLElement } | null = null
  let fallback: FindTarget | null = null
  for (const target of targets) {
    const element = target.element()
    if (!element || !visible(element)) continue
    if (target.fallback) fallback = target
    if (!anchor || !element.contains(anchor)) continue
    // Innermost wins: an artifact embedded in something larger is the one meant.
    if (!best || best.element.contains(element)) best = { target, element }
  }
  return best?.target ?? fallback
}

/** Open the find bar for whatever surface the reader is in. False when there is none. */
export function openFindForFocus(): boolean {
  const focused = document.activeElement
  const anchor =
    focused && focused !== document.body && focused !== document.documentElement
      ? focused
      : lastPointerTarget
  const target = findTargetFor(anchor)
  if (!target) return false
  target.open(selectionSeed())
  return true
}

/** Register `ref`'s element as a ⌘F surface for as long as the component is mounted. */
export function useFindTarget(
  ref: React.RefObject<HTMLElement | null>,
  open: (seed?: string) => void,
  fallback = false,
): void {
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  })
  useEffect(
    () =>
      registerFindTarget({
        element: () => ref.current,
        open: (seed) => openRef.current(seed),
        fallback,
      }),
    [ref, fallback],
  )
}
