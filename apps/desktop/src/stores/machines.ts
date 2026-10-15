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
  signedIn = view.account.status === 'signed-in'
  const state = useMachinesStore.getState()
  state.enableRemote(signedIn)
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
    if (!get().remoteEnabled) return Promise.resolve()
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
  adding: false,
  view: { kind: 'list' },
  show: (view) => {
    set({ view })
    useLayoutStore.getState().setPage('machines')
  },
}))
