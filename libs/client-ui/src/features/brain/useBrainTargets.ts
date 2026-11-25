import { useEffect, useRef } from 'react'
import type { BrainTarget } from './brainNavigation'

/** Apply what a notice, toast or the search button asked for, once per request. */
export function useBrainTargets(
  target: { value: BrainTarget; request: number } | null,
  actions: {
    openSearch: () => void
    showChanges: () => void
    openRecord: (jobId: string) => void
  },
): void {
  const latest = useRef(actions)
  latest.current = actions
  const applied = useRef(0)
  useEffect(() => {
    if (!target || target.request === applied.current) return
    applied.current = target.request
    const { value } = target
    if (value.search) latest.current.openSearch()
    if (value.changes) latest.current.showChanges()
    if (value.jobId) latest.current.openRecord(value.jobId)
  }, [target])
}
