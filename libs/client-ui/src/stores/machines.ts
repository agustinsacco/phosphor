import { machineStatus, type MachineView, type MachineStatus } from '@shared/control-api'
import type { AccountView } from '@shared/account'
import type { DesktopControlErrorCode } from '@shared/ipc'
import { create } from 'zustand'
import { useLayoutStore } from './layout'

/** Selected detail survives account and live-directory updates. */
export type MachinesView = { kind: 'list' } | { kind: 'machine'; id: string }

interface MachinesState {
  machines: readonly MachineView[]
  statuses: Readonly<Record<string, MachineStatus>>
  nowMs: number
  clockOffsetMs: number
  loading: boolean
  error: DesktopControlErrorCode | null
  remoteEnabled: boolean
  directoryLoaded: boolean
  enableRemote: (enabled: boolean) => void
  refresh: () => Promise<void>
  adding: boolean
  view: MachinesView
  show: (view: MachinesView) => void
}

let remoteGeneration = 0
/** Reject action replies from a previous account, including sign-out then sign-in. */
export const machinesAccountGeneration = (): number => remoteGeneration
let inFlight: Promise<void> | null = null
let queued = false
let judgeTimer: ReturnType<typeof setInterval> | undefined
let requested = false
let detach: (() => void) | undefined
let subscribers = 0
const REMOTE_RESET = {
  machines: [],
  statuses: {},
  nowMs: 0,
  clockOffsetMs: 0,
  directoryLoaded: false,
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
/** One store-owned subscription. Desktop starts discovery when requested; the browser needs Hosts to open any lane. */
export function attachMachinesListener(onDemand = false): () => void {
  if (subscribers++ === 0) {
    let pushed = false
    let active = true
    let signingIn = false
    requested = !onDemand || useLayoutStore.getState().page === 'machines'
    const applyAccount = ({ account }: AccountView) => {
      if (signingIn && account.status === 'signed-in') requested = true
      signingIn = account.status === 'signing-in'
      useMachinesStore.getState().enableRemote(account.status === 'signed-in')
    }
    const offPage = useLayoutStore.subscribe((next) => {
      if (requested || next.page !== 'machines') return
      requested = true
      void useMachinesStore.getState().refresh()
    })
    const offAccount = window.phosphor.onAccountChanged((view) => {
      pushed = true
      applyAccount(view)
    })
    const offMachines = window.phosphor.onMachinesChanged(() => {
      if (requested) void useMachinesStore.getState().refresh()
    })
    void window.phosphor
      .invoke('account:get')
      .then((view) => {
        if (!active) return
        if (!pushed) {
          requested ||= view.remoteDiscoveryActive === true
          applyAccount(view)
        } else if (
          !requested &&
          view.remoteDiscoveryActive &&
          useMachinesStore.getState().remoteEnabled
        ) {
          void useMachinesStore.getState().refresh()
        }
      })
      .catch(() => undefined)
    detach = () => {
      active = false
      offAccount()
      offMachines()
      offPage()
      requested = false
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

export const useMachinesStore = create<MachinesState>((set, get) => ({
  ...REMOTE_RESET,
  remoteEnabled: false,
  enableRemote: (enabled) => {
    if (enabled === get().remoteEnabled) return
    remoteGeneration++
    queued = false
    set({ remoteEnabled: enabled, ...REMOTE_RESET })
    syncJudge()
    if (enabled && requested) void get().refresh()
  },
  refresh: () => {
    if (!get().remoteEnabled) return Promise.resolve()
    requested = true
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
                directoryLoaded: true,
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
  adding: false,
  view: { kind: 'list' },
  show: (view) => {
    set({ view })
    useLayoutStore.getState().setPage('machines')
  },
}))
