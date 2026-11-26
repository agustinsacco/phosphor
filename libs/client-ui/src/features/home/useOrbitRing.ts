import { useRef, useState, type HTMLAttributes } from 'react'
import { orbitStep, type OrbitLane } from './orbitLanes'

function laneAt(target: EventTarget | null): string | null {
  return target instanceof Element
    ? (target.closest('[data-lane-id]')?.getAttribute('data-lane-id') ?? null)
    : null
}

/**
 * The ring's pointer and keyboard model, delegated from the dial so the dots stay plain.
 * A mouse previews on hover and opens on click. A touch has no hover, so its first tap
 * previews (the centre offers Open) and a second tap on the same dot opens. The ring is
 * one tab stop; arrows walk it and wrap, Home and End jump to its ends.
 *
 * Lanes re-sort as their state changes, so every position is a lane id, never an index:
 * an arrow steps from where the focused lane sits now, not where it sat when focused.
 */
export function useOrbitRing(shown: readonly OrbitLane[], open: (laneId: string) => void) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const pointer = useRef<string | null>(null)
  const dots = useRef<Array<HTMLButtonElement | null>>([])
  const indexOf = (id: string | null) => shown.findIndex((entry) => entry.lane.laneId === id)
  const tabStop = Math.max(indexOf(cursor), 0)
  const handlers: HTMLAttributes<HTMLDivElement> = {
    onPointerDown: (e) => {
      pointer.current = e.pointerType
    },
    // A scroll that starts on the ring cancels the tap; the next Enter must still open.
    onPointerCancel: () => {
      pointer.current = null
    },
    onPointerOver: (e) => {
      if (e.pointerType === 'mouse') setHovered(laneAt(e.target))
    },
    onPointerLeave: () => setHovered(null),
    onFocus: (e) => {
      const id = laneAt(e.target)
      if (!id) return
      setFocused(id)
      setCursor(id)
    },
    onBlur: (e) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
      setFocused(null)
      setPicked(null)
    },
    onClick: (e) => {
      // A click without a pointer before it came from the keyboard: it opens, as a mouse does.
      const touch = pointer.current !== null && pointer.current !== 'mouse'
      pointer.current = null
      const id = laneAt(e.target)
      if (!id) return
      if (touch && picked !== id) setPicked(id)
      else open(id)
    },
    onKeyDown: (e) => {
      pointer.current = null
      if (e.key === 'Escape' && picked) {
        e.stopPropagation()
        setPicked(null)
        return
      }
      const from = indexOf(laneAt(e.target))
      const index = from < 0 ? null : orbitStep(e.key, from, shown.length)
      if (index === null) return
      e.preventDefault()
      // The keyboard took over: a resting mouse no longer names the lane in the centre.
      setHovered(null)
      dots.current[index]?.focus()
    },
  }
  return { previewId: hovered ?? picked ?? focused, picked, tabStop, dots, handlers, open }
}
