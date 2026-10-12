import { create } from 'zustand'
import {
  FAKE_LANES,
  finishLane,
  machineById,
  nextToFinish,
  type RemoteLane,
} from '@/features/machines/fakeMachines'
import { useExtensionUiStore } from './extensionUi'
import { useLayoutStore } from './layout'

export type MachineTab = 'overview' | 'lanes' | 'dependencies' | 'logins'

/** What the Machines page shows: the list, one machine, or one lane on another machine. */
export type MachinesView =
  { kind: 'list' } | { kind: 'machine'; id: string; tab: MachineTab } | { kind: 'lane'; id: string }

interface MachinesState {
  /** Settings → Advanced → Machines (preview). Off unless set. */
  preview: boolean
  /** Sidebar machine filter: 'all', LOCAL_MACHINE, or a machine id. Not persisted. */
  filter: string
  /** The made-up lanes, whose state the finish demo changes until the preview goes off. */
  lanes: RemoteLane[]
  view: MachinesView
  /** From prefs at hydrate: no IPC. */
  applyPreview: (on: boolean) => void
  setPreview: (on: boolean) => Promise<void>
  setFilter: (filter: string) => void
  /** Open the Machines page on this view. */
  show: (view: MachinesView) => void
  /** End a live lane (the next one when no id) and send the notice a real finish would. */
  pretendFinished: (id?: string) => void
}

const RESET = { filter: 'all', lanes: [...FAKE_LANES], view: { kind: 'list' } as MachinesView }

/**
 * The Machines preview: a prototype of the machine-aware sidebar and the
 * Machines page against made-up machines (`features/machines/fakeMachines.ts`).
 * Turning it off puts everything back, the page included.
 */
export const useMachinesStore = create<MachinesState>((set, get) => ({
  preview: false,
  ...RESET,

  applyPreview: (on) => set(on ? { preview: true } : { preview: false, ...RESET }),

  setPreview: async (on) => {
    await window.phosphor.invoke('app:setMachinesPreview', on)
    get().applyPreview(on)
    const layout = useLayoutStore.getState()
    if (!on && layout.page === 'machines') layout.setPage(null)
  },

  setFilter: (filter) => set({ filter }),

  show: (view) => {
    set({ view })
    useLayoutStore.getState().setPage('machines')
  },

  pretendFinished: (id) => {
    const lane = id ? get().lanes.find((l) => l.id === id) : nextToFinish(get().lanes)
    if (!lane || lane.state === 'done') return
    set({ lanes: finishLane(get().lanes, lane.id) })
    useExtensionUiStore.getState().notify({
      title: lane.title,
      message: `Finished on ${machineById(lane.machineId)?.name ?? lane.machineId}`,
      kind: 'success',
      openLabel: 'Open lane',
      onOpen: () => get().show({ kind: 'lane', id: lane.id }),
    })
  },
}))
