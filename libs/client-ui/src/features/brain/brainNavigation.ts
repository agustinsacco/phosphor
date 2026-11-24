import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { useLayoutStore } from '@/stores/layout'

/** Where a notice, toast or another page asks the Brain page to go. */
export interface BrainTarget {
  /** Open Brain search. */
  search?: true
  /** Show What changed. */
  changes?: true
  /** Open how this read was read. */
  jobId?: string
}
export const useBrainNavigation = create<{
  /** Counts every openBrain() and never goes back, so each request has its own number. */
  request: number
  target: BrainTarget | null
}>(() => ({ request: 0, target: null }))

export function openBrain(target: BrainTarget = {}): void {
  useBrainNavigation.setState((s) => ({ request: s.request + 1, target }))
  useLayoutStore.getState().setPage('brain')
}

/** The latest target a notice or another page asked for, consumed once. */
export function useBrainTarget(): { value: BrainTarget; request: number } | null {
  const [target, setTarget] = useState<{ value: BrainTarget; request: number } | null>(null)
  const request = useBrainNavigation((s) => s.request)
  useEffect(() => {
    const next = useBrainNavigation.getState().target
    if (!request || !next) return
    setTarget({ value: next, request })
    // Only the target is consumed: a page mounted later must not replay it.
    useBrainNavigation.setState({ target: null })
  }, [request])
  return target
}

export function brainIsVisible(): boolean {
  return useLayoutStore.getState().page === 'brain'
}
