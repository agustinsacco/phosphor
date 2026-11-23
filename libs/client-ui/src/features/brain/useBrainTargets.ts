import { useEffect, useRef } from 'react'
import type { BrainTarget } from './brainNavigation'
import type { LaneSelection } from './lanes/laneGroups'

/** Apply what a notice, toast or the search button asked for, once per request. */
export function useBrainTargets(
  target: { value: BrainTarget; request: number } | null,
  actions: {
    setLane: (selection: LaneSelection | null) => void
    focusSearch: () => void
  },
): void {
  const latest = useRef(actions)
  latest.current = actions
  const applied = useRef(0)
  useEffect(() => {
    if (!target || target.request === applied.current) return
    applied.current = target.request
    const { value } = target
    const { setLane, focusSearch } = latest.current
    if (value.tab === 'lanes' && value.jobId) setLane({ type: 'job', id: value.jobId })
    if (value.tab === 'lanes' && value.recent) setLane({ type: 'change', id: null })
    if (value.tab === 'knowledge' && value.search) focusSearch()
  }, [target])
}
