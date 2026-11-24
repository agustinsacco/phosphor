import { useEffect, useRef } from 'react'
import type { BrainTarget } from './brainNavigation'

/** Apply what a notice, toast or the search button asked for, once per request. */
export function useBrainTargets(
  target: { value: BrainTarget; request: number } | null,
  actions: {
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
    const { focusSearch } = latest.current
    if (value.tab === 'knowledge' && value.search) focusSearch()
  }, [target])
}
