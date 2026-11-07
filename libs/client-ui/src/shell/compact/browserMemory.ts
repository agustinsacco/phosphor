import { create } from 'zustand'
import type { HostConnectionView } from '@shared/ipc'
import { locationMachine, type Location, type Page } from '@/navigation/location'
import { machineCaps } from '@/stores/machineCaps'

export const LIBRARY_PAGES = ['skills', 'routines', 'artifacts'] as const satisfies readonly Page[]
export type LibraryPage = (typeof LIBRARY_PAGES)[number]

export const isLibraryPage = (page: Page): page is LibraryPage =>
  (LIBRARY_PAGES as readonly Page[]).includes(page)

/**
 * Where this browser was, so its tabs, Back and New return there: the last lane list (null
 * before one was shown), the last machine looked at, and the last Library page. In memory
 * only, and cleared with the rest of an owner's UI.
 */
type LaneList = { to: 'lanes'; machine?: string }
interface BrowserMemory {
  lanes: LaneList | null
  lastMachine: string | undefined
  library: LibraryPage
}
const EMPTY: BrowserMemory = { lanes: null, lastMachine: undefined, library: 'skills' }
export const useBrowserMemory = create<BrowserMemory>(() => EMPTY)

export function clearBrowserMemory(): void {
  useBrowserMemory.setState(EMPTY)
}

/** Where a lane's Back goes: the list you came from if it shows this lane, else its machine's. */
export function laneListFor(hostId: string): LaneList {
  const { lanes } = useBrowserMemory.getState()
  return lanes && (!lanes.machine || lanes.machine === hostId)
    ? lanes
    : { to: 'lanes', machine: hostId }
}

/** Records what a location says about where the person is. */
export function rememberLocation(location: Location): void {
  const machine = locationMachine(location)
  useBrowserMemory.setState((memory) => ({
    lanes:
      location.to === 'lanes'
        ? { to: 'lanes', ...(location.machine ? { machine: location.machine } : {}) }
        : memory.lanes,
    lastMachine: machine ?? memory.lastMachine,
    library:
      location.to === 'page' && isLibraryPage(location.page) ? location.page : memory.library,
  }))
}

/**
 * The machine New and the Library open on: the one in view, else the last one looked at,
 * else the first that can start a lane now, else any. Undefined only with no machines.
 */
export function scopedMachine(
  inView: string | undefined,
  lastMachine: string | undefined,
  machines: readonly { id: string }[],
  hosts: Record<string, HostConnectionView>,
): string | undefined {
  const known = (id: string | undefined): id is string =>
    !!id && machines.some((machine) => machine.id === id)
  if (known(inView)) return inView
  if (known(lastMachine)) return lastMachine
  return (
    machines.find((machine) => machineCaps(hosts[machine.id]).can('sessions.control'))?.id ??
    machines[0]?.id
  )
}
