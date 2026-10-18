import { useRemoteLanesStore } from './remoteLanes'
import { create } from 'zustand'
import type { GlobalPage } from './layout'
import { useLayoutStore } from './layout'

/** In-memory page targets set by machine-detail links, never inferred from a path. */
export const useMachinePagesStore = create<{
  skillsMachine: string | null
  routinesMachine: string
  artifactsMachine: string
}>(() => ({ skillsMachine: null, routinesMachine: '', artifactsMachine: '' }))

export function openMachinePage(page: GlobalPage, hostId: string): void {
  if (page === 'skills') useMachinePagesStore.setState({ skillsMachine: hostId })
  if (page === 'routines') useMachinePagesStore.setState({ routinesMachine: `host:${hostId}` })
  if (page === 'artifacts') useMachinePagesStore.setState({ artifactsMachine: hostId })
  useLayoutStore.getState().setPage(page)
}

// A sidebar change clears page overrides even while a page is unmounted.
useRemoteLanesStore.subscribe((state, previous) => {
  if (state.filter !== previous.filter)
    useMachinePagesStore.setState({
      skillsMachine: null,
      routinesMachine: '',
      artifactsMachine: '',
    })
})

export function pageMachine(filter: string, override: string | null, all = false): string {
  return override || (filter === 'all' ? (all ? 'all' : 'local') : filter)
}
