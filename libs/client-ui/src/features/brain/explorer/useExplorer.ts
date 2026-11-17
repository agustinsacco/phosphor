import { useCallback, useState } from 'react'
import type { BrainLink } from '@shared/brain'
import { initialTrail, moveTrail, replaceTrailStep, visitTrail, type BrainVisit } from './trail'

/** The Knowledge trail and the route a user asked to see; kept while other tabs are open. */
export function useExplorer() {
  const [trail, setTrail] = useState(initialTrail)
  const [path, setPath] = useState<BrainLink[] | null>(null)
  const onVisit = useCallback((next: BrainVisit): void => {
    setTrail((old) => visitTrail(old, next))
    setPath(null)
  }, [])
  const move = useCallback((delta: number): void => {
    setTrail((old) => moveTrail(old, delta))
    setPath(null)
  }, [])
  const jump = useCallback((index: number): void => {
    setTrail((old) => ({ ...old, index }))
    setPath(null)
  }, [])
  const replace = useCallback((visit: BrainVisit): void => {
    setTrail((old) => replaceTrailStep(old, visit))
  }, [])
  return { trail, visit: trail.items[trail.index], path, onVisit, move, jump, replace, setPath }
}
export type ExplorerState = ReturnType<typeof useExplorer>
