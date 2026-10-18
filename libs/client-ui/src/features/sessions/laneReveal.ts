import { useEffect, useRef } from 'react'
import { create } from 'zustand'

export const useLaneRevealStore = create<{ seq: number; groupKey: string | null }>(() => ({
  seq: 0,
  groupKey: null,
}))

export const localLaneGroupKey = (workspacePath: string): string => workspacePath
export const remoteLaneGroupKey = (hostId: string, repositoryId: string): string =>
  `host:${hostId}:${repositoryId}`

export function requestReveal(groupKey: string): void {
  useLaneRevealStore.setState((state) => ({ seq: state.seq + 1, groupKey }))
}

/** A remounted group still answers the most recent navigation request. */
export function LaneRevealEffect({
  groupKey,
  collapsed,
  expand,
  clearSearch,
}: {
  groupKey: string
  collapsed: boolean
  expand: () => void
  clearSearch: () => void
}): null {
  useLaneReveal(groupKey, () => {
    if (collapsed) expand()
    clearSearch()
  })
  return null
}

export function useLaneReveal(groupKey: string, reveal: () => void): void {
  const request = useLaneRevealStore()
  const handled = useRef(0)
  useEffect(() => {
    if (request.groupKey !== groupKey || request.seq === handled.current) return
    handled.current = request.seq
    reveal()
  }, [request, groupKey, reveal])
}
