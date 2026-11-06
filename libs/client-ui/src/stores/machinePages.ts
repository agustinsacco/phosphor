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

/**
 * Opens a global page filtered to one machine: `'local'` for This Mac, otherwise
 * a Host id. Null drops any override, so the page follows the sidebar.
 */
export function openMachinePage(page: GlobalPage, machine: string | null): void {
  if (page === 'skills') useMachinePagesStore.setState({ skillsMachine: machine })
  if (page === 'routines')
    useMachinePagesStore.setState({
      routinesMachine: machine === null ? '' : routineScope(machine),
    })
  if (page === 'artifacts') useMachinePagesStore.setState({ artifactsMachine: machine ?? '' })
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

/** The routines scope of a machine: `'local'` and `'all'` as they are, a Host id as `host:<id>`. */
export function routineScope(machine: string): string {
  return machine === 'local' || machine === 'all' || machine.startsWith('host:')
    ? machine
    : `host:${machine}`
}

export function pageMachine(filter: string, override: string | null, all = false): string {
  return override || (filter === 'all' ? (all ? 'all' : 'local') : filter)
}
