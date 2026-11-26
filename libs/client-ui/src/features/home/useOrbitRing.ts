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
 */
export function useOrbitRing(shown: readonly OrbitLane[], open: (laneId: string) => void) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)
  const pointer = useRef<string | null>(null)
  const dots = useRef<Array<HTMLButtonElement | null>>([])
  const tabStop = Math.min(cursor, Math.max(shown.length - 1, 0))
  const handlers: HTMLAttributes<HTMLDivElement> = {
    onPointerDown: (e) => {
      pointer.current = e.pointerType
    },
    onPointerOver: (e) => {
      if (e.pointerType === 'mouse') setHovered(laneAt(e.target))
    },
    onPointerLeave: () => setHovered(null),
    onFocus: (e) => {
      const id = laneAt(e.target)
      if (!id) return
      setFocused(id)
      setCursor(
        Math.max(
          0,
          shown.findIndex((entry) => entry.lane.laneId === id),
        ),
      )
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
      if (e.key === 'Escape' && picked) {
        e.stopPropagation()
        setPicked(null)
        return
      }
      const index = laneAt(e.target) ? orbitStep(e.key, tabStop, shown.length) : null
      if (index === null) return
      e.preventDefault()
      setCursor(index)
      dots.current[index]?.focus()
    },
  }
  return { previewId: hovered ?? picked ?? focused, picked, tabStop, dots, handlers, open }
}
