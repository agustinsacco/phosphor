import type { MachineView } from '@shared/control-api'
import type { DesktopControlErrorCode } from '@shared/ipc'
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
  machines: readonly MachineView[]
  clockOffsetMs: number
  loading: boolean
  error: DesktopControlErrorCode | null
  remoteEnabled: boolean
  enableRemote: (enabled: boolean) => void
  refresh: () => Promise<void>
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
 * Notices the finish demo sent and has not yet withdrawn. A notice outlives a
 * click on the switch, and opening one after the preview went off would bring
 * the made-up page back, so turning it off dismisses them.
 */
const notices = new Set<number>()
let remoteGeneration = 0
let requestGeneration = 0
const REMOTE_RESET = { machines: [], clockOffsetMs: 0, loading: false, error: null }

/**
 * Enrolled machines are a main-process projection while the signed-in page is open.
 * The sidebar and signed-out page keep their separate sample machines and lanes.
 * Turning it off puts everything back, the page included.
 */
export const useMachinesStore = create<MachinesState>((set, get) => ({
  ...REMOTE_RESET,
  remoteEnabled: false,
  enableRemote: (enabled) => {
    remoteGeneration++
    set({ remoteEnabled: enabled, ...REMOTE_RESET })
  },
  refresh: async () => {
    if (!get().preview || !get().remoteEnabled) return
    const generation = remoteGeneration
    const request = ++requestGeneration
    set({ loading: true, error: null })
    try {
      const result = await window.phosphor.invoke('control:machines')
      if (generation !== remoteGeneration || request !== requestGeneration) return
      set(
        result.ok
          ? {
              machines: result.machines,
              clockOffsetMs: Date.parse(result.serverTime) - Date.now(),
              loading: false,
            }
          : {
              ...(result.error.code === 'signed-out' ? REMOTE_RESET : {}),
              loading: false,
              error: result.error.code,
            },
      )
    } catch {
      if (generation === remoteGeneration && request === requestGeneration)
        set({ loading: false, error: 'offline' })
    }
  },
  preview: false,
  ...RESET,

  applyPreview: (on) => {
    if (!on) {
      get().enableRemote(false)
      const toasts = useExtensionUiStore.getState()
      for (const id of notices) toasts.dismissToast(id)
      notices.clear()
    }
    set(on ? { preview: true } : { preview: false, ...RESET })
  },

  setPreview: async (on) => {
    await window.phosphor.invoke('app:setMachinesPreview', on)
    get().applyPreview(on)
    const layout = useLayoutStore.getState()
    if (!on && layout.page === 'machines') layout.setPage(null)
  },

  setFilter: (filter) => set({ filter }),

  show: (view) => {
    // Off means off: nothing opens the made-up page, an old callback included.
    if (!get().preview) return
    set({ view })
    useLayoutStore.getState().setPage('machines')
  },

  pretendFinished: (id) => {
    if (!get().preview) return
    const lane = id ? get().lanes.find((l) => l.id === id) : nextToFinish(get().lanes)
    if (!lane || lane.state === 'done') return
    set({ lanes: finishLane(get().lanes, lane.id) })
    const notice = useExtensionUiStore.getState().notify({
      title: lane.title,
      message: `Finished on ${machineById(lane.machineId)?.name ?? lane.machineId}`,
      kind: 'success',
      openLabel: 'Open lane',
      onOpen: () => get().show({ kind: 'lane', id: lane.id }),
    })
    notices.add(notice)
  },
}))
