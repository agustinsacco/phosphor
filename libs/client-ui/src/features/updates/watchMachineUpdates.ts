import { useEffect } from 'react'
import { usePlatform } from '@/platform/Platform'
import type { HostConnectionView, LocalMachineStatus } from '@shared/ipc'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import {
  machineUpdateEntry,
  updateMachineEntry,
  useMachineUpdatesStore,
} from '@/stores/machineUpdates'
import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { localServiceId } from '@/stores/localServiceScope'
import { lastUpdateOf, readUpdateJob, readUpdateStatus } from './machineUpdateFacts'
import { changeUpdateRun, reconnectForUpdate, updateOp } from './machineUpdateRun'
import {
  observeConnection,
  observePause,
  startRun,
  tickRun,
  type UpdateStatus,
} from './machineUpdateState'

function applyStatus(
  id: string,
  host: HostConnectionView,
  status: UpdateStatus | undefined,
  local?: LocalMachineStatus,
) {
  updateMachineEntry(id, (entry) => {
    const next = {
      ...entry,
      status: status ?? entry.status,
      version: host.hostVersion ?? local?.serviceVersion ?? entry.version,
      last: lastUpdateOf(entry, status, local),
    }
    const pause = status?.pause
    const active = pause && pause.kind !== 'none'
    let run = entry.run
    if (active && (!run || (run.settled && entry.status?.pause.kind === 'none')))
      run = startRun('op', entry, host, Date.now())
    if (!run) return next
    const now = Date.now()
    run = observePause(run, pause, now)
    return { ...next, run: tickRun(observeConnection(run, next, host, now), now) }
  })
}

function applyConnection(id: string, host: HostConnectionView | undefined, now: number) {
  updateMachineEntry(id, (entry) => {
    const version = host?.state === 'ready' ? (host.hostVersion ?? entry.version) : entry.version
    const run = entry.run && tickRun(observeConnection(entry.run, entry, host, now), now)
    return run === entry.run && version === entry.version ? entry : { ...entry, run, version }
  })
}

interface Schedule {
  generation: number
  readAt: number
  reading: boolean
  reconnectAt: number
}

/** This Mac's owner-socket status, when it describes the service in scope. */
function applyLocalStatus(status: LocalMachineStatus) {
  const hosts = useRemoteLanesStore.getState().hosts
  const id = localServiceId(hosts)
  const host = id && hosts[id]
  if (!id || !host || status.mode !== 'daemon') return
  const entry = machineUpdateEntry(id)
  if (status.service === 'ready' && host.state === 'ready') {
    // The owner socket says nothing about availability: keep the Host's own report.
    const facts = status.pause && {
      pause: status.pause,
      pauseControl: entry.status?.pauseControl,
      update: entry.status?.update,
    }
    applyStatus(id, host, facts, status)
  }
}

interface Watch {
  live: () => boolean
  local: boolean
  schedule: Map<string, Schedule>
  readOwner: () => Promise<void>
}

async function readMachine(watch: Watch, id: string, host: HostConnectionView, clock: Schedule) {
  const current = () =>
    watch.live() &&
    machineReadGeneration(id) === clock.generation &&
    watch.schedule.get(id) === clock
  const run = machineUpdateEntry(id).run
  clock.reading = true
  try {
    const reads = await Promise.all([
      host.ops && host.capabilities.includes('sessions.read')
        ? updateOp(id, 'machine.status').catch(() => undefined)
        : undefined,
      run?.jobId && !run.finish
        ? updateOp(id, 'job.status', { jobId: run.jobId }).catch(() => undefined)
        : undefined,
      watch.local && host.local ? watch.readOwner() : undefined,
    ])
    if (!current()) return
    const [answer, job] = reads
    if (answer?.status === 'ok') applyStatus(id, host, readUpdateStatus(answer.data))
    if (run && job)
      changeUpdateRun(id, run.started, (latest) =>
        tickRun(readUpdateJob(latest, job, Date.now()), Date.now()),
      )
  } finally {
    clock.reading = false
  }
}

/** One machine's turn: track its connection, push a reconnect during a run, read when due. */
function pollMachine(
  watch: Watch,
  id: string,
  host: HostConnectionView | undefined,
  now: number,
  focus: boolean,
) {
  applyConnection(id, host, now)
  const run = machineUpdateEntry(id).run
  if (!host && (!run || run.settled)) {
    watch.schedule.delete(id)
    return
  }
  const generation = machineReadGeneration(id)
  const old = watch.schedule.get(id)
  const clock =
    old?.generation === generation
      ? old
      : { generation, readAt: -Infinity, reading: false, reconnectAt: old?.reconnectAt ?? now }
  watch.schedule.set(id, clock)
  if (!run?.settled && run && host?.state !== 'ready' && now >= clock.reconnectAt) {
    clock.reconnectAt = now + 3000
    void reconnectForUpdate(id)
  }
  const every = run && !run.settled ? 2000 : focus ? 5 * 60_000 : 30 * 60_000
  if (
    host?.state === 'ready' &&
    (host.ops || (watch.local && host.local)) &&
    !clock.reading &&
    now - clock.readAt >= every
  ) {
    clock.readAt = now
    void readMachine(watch, id, host, clock).catch(() => undefined)
  }
}

const connectionChanged = (
  state: { hosts: Record<string, HostConnectionView> },
  before: { hosts: Record<string, HostConnectionView> },
) =>
  Object.keys(state.hosts).some(
    (id) =>
      state.hosts[id]?.state !== before.hosts[id]?.state ||
      state.hosts[id]?.connectionToken !== before.hosts[id]?.connectionToken ||
      state.hosts[id]?.hostVersion !== before.hosts[id]?.hostVersion ||
      state.hosts[id]?.cursor?.epoch !== before.hosts[id]?.cursor?.epoch,
  ) || Object.keys(before.hosts).some((id) => !(id in state.hosts))

/** Shell-owned observation, independent of the Settings page and of any agent lane. */
export function watchMachineUpdates(owner: boolean): () => void {
  if (!window.phosphor?.invoke) return () => {}
  let live = true
  let ownerTicket = 0
  const local = owner && typeof window.phosphor.onLocalMachineChanged === 'function'
  const offLocal = local
    ? window.phosphor.onLocalMachineChanged((status) => {
        ownerTicket++
        applyLocalStatus(status)
      })
    : undefined
  const watch: Watch = {
    live: () => live,
    local,
    schedule: new Map(),
    readOwner: async () => {
      const ticket = ++ownerTicket
      const status = await window.phosphor.invoke('app:localMachine').catch(() => undefined)
      if (live && ticket === ownerTicket && status) applyLocalStatus(status)
    },
  }
  function poll(focus = false) {
    const now = Date.now()
    const hosts = useRemoteLanesStore.getState().hosts
    for (const id of new Set([...Object.keys(hosts), ...watch.schedule.keys()]))
      pollMachine(watch, id, hosts[id], now, focus)
  }
  // Observe even ready -> reconnecting -> ready in a single render, without rereading on lane traffic.
  const stop = useRemoteLanesStore.subscribe((state, before) => {
    if (connectionChanged(state, before)) poll()
  })
  const focus = () => poll(true)
  window.addEventListener('focus', focus)
  const timer = window.setInterval(poll, 200)
  poll()
  return () => {
    live = false
    stop()
    offLocal?.()
    window.clearInterval(timer)
    window.removeEventListener('focus', focus)
    useMachineUpdatesStore.setState({ byMachine: {} })
  }
}

export function useMachineUpdateObserver(): void {
  const { localLanes } = usePlatform()
  useEffect(() => watchMachineUpdates(localLanes), [localLanes])
}
