import { machineStatus, type MachineView, type MachineStatus } from '@shared/control-api'
import type { AccountView } from '@shared/account'
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
  statuses: Readonly<Record<string, MachineStatus>>
  nowMs: number
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
let inFlight: Promise<void> | null = null
let queued = false
let judgeTimer: ReturnType<typeof setInterval> | undefined
let signedIn = false
let detach: (() => void) | undefined
let subscribers = 0
const REMOTE_RESET = {
  machines: [],
  statuses: {},
  nowMs: 0,
  clockOffsetMs: 0,
  loading: false,
  error: null,
}

function judge(): void {
  const state = useMachinesStore.getState()
  const nowMs = Date.now()
  const statuses = Object.fromEntries(
    state.machines.map((machine) => [
      machine.id,
      machineStatus(machine, nowMs, state.clockOffsetMs),
    ]),
  )
  useMachinesStore.setState({ nowMs, statuses })
}
function syncJudge(): void {
  clearInterval(judgeTimer)
  judgeTimer = undefined
  judge()
  if (useMachinesStore.getState().machines.length) judgeTimer = setInterval(judge, 5000)
}
function applyAccount(view: AccountView): void {
  signedIn = view.preview && view.account.status === 'signed-in'
  const state = useMachinesStore.getState()
  state.enableRemote(signedIn && state.preview)
}

/** One store-owned subscription, independent of the Machines page. */
export function attachMachinesListener(): () => void {
  if (subscribers++ === 0) {
    let pushed = false
    let active = true
    const offAccount = window.phosphor.onAccountChanged((view) => {
      pushed = true
      applyAccount(view)
    })
    const offMachines = window.phosphor.onMachinesChanged(() => {
      void useMachinesStore.getState().refresh()
    })
    void window.phosphor
      .invoke('account:get')
      .then((view) => {
        if (active && !pushed) applyAccount(view)
      })
      .catch(() => undefined)
    detach = () => {
      active = false
      offAccount()
      offMachines()
      signedIn = false
      useMachinesStore.getState().enableRemote(false)
    }
  }
  let active = true
  return () => {
    if (!active) return
    active = false
    if (--subscribers === 0) {
      detach?.()
      detach = undefined
    }
  }
}

/**
 * Enrolled machines stay current while signed in, even with the page closed.
 * The sidebar and signed-out page keep their separate sample machines and lanes.
 * Turning it off puts everything back, the page included.
 */
export const useMachinesStore = create<MachinesState>((set, get) => ({
  ...REMOTE_RESET,
  remoteEnabled: false,
  enableRemote: (enabled) => {
    if (enabled === get().remoteEnabled) return
    remoteGeneration++
    queued = false
    set({ remoteEnabled: enabled, ...REMOTE_RESET })
    syncJudge()
    if (enabled) void get().refresh()
  },
  refresh: () => {
    if (!get().preview || !get().remoteEnabled) return Promise.resolve()
    if (inFlight) {
      queued = true
      return inFlight
    }
    const generation = remoteGeneration
    set({ loading: true, error: null })
    inFlight = (async () => {
      try {
        const result = await window.phosphor.invoke('control:machines')
        if (generation !== remoteGeneration) return
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
        syncJudge()
      } catch {
        if (generation === remoteGeneration) set({ loading: false, error: 'offline' })
      }
    })().finally(() => {
      inFlight = null
      if (queued) {
        queued = false
        void get().refresh()
      }
    })
    return inFlight
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
    if (on && signedIn) get().enableRemote(true)
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
