import { useEffect, useState } from 'react'
import { pageKeyTarget } from './pageKeys'
import type { MapStep } from './map/SentenceMap'
import { moveWalk, NO_WALK, walkStep, walkTo } from './screen/walk'

type Place = MapStep['to']

/** Local click history only. The owning Host page remounts it on scope or generation change. */
export function useHostGraphWalk(start: Place | null, clearOverlay: () => void) {
  const [walk, setWalk] = useState(NO_WALK)
  const place = walk.steps[walk.index] ?? start
  const step = ({ to, link }: MapStep) => {
    setWalk((current) => {
      const from = current.steps[current.index] ?? start
      return walkTo(current, from, walkStep(from ?? to, to, link))
    })
    clearOverlay()
  }
  const move = (delta: number) => {
    setWalk((current) => moveWalk(current, delta))
    clearOverlay()
  }
  const jump = (index: number) => {
    setWalk((current) => ({ ...current, index }))
    clearOverlay()
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (pageKeyTarget(event, '[')) move(-1)
      else if (pageKeyTarget(event, ']')) move(1)
      else return
      event.preventDefault()
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [clearOverlay])
  return {
    place,
    walk,
    step,
    move,
    jump,
    trail: walk.steps.slice(0, walk.index + 1).flatMap((step) => (step.link ? [step.link] : [])),
  }
}
