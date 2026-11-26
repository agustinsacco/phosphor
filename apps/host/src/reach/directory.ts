/**
 * Machine reach, caller side: this daemon's sibling directory from control
 * (`GET /hosts/self/machines`, signed with the machine key), cached 30 seconds
 * and single-flight. A 404 is an older control plane. Living contract:
 * docs/agent-control.md ("Machines").
 */
import {
  CONTROL_MACHINE_ROUTES,
  parseMachineDirectoryResponse,
  type MachineDirectoryEntry,
  type MachineDirectoryResponse,
} from '@phosphor/shared/control-api'
import type {
  ReachBudget,
  ReachDirectory,
  ReachMachine,
  ReachUnavailable,
} from '@phosphor/session-runtime/ops/reach'
import {
  controlStage,
  createReachRequester,
  type ReachControl,
  type ReachControlPorts,
} from './control'
export type { ReachControl, ReachControlPorts } from './control'
import { ControlFailure } from '../control/client-response'

export const REACH_DIRECTORY_TTL_MS = 30_000
/** Control refuses a grant to a target last seen longer ago than this. */
export const REACH_SEEN_WITHIN_MS = 90_000

function unavailable(reason: ReachUnavailable): ReachDirectory {
  return { available: false, reason }
}

function failureReason(error: unknown): ReachUnavailable {
  if (!(error instanceof ControlFailure)) return controlStage(error)
  if (error.code === 'not-found') return 'control-old'
  if (error.code === 'gone' || error.code === 'unauthenticated') return 'signed-out'
  if (error.code === 'forbidden') return 'account-disabled'
  return controlStage(error)
}

function machine(entry: MachineDirectoryEntry, serverTime: number): ReachMachine {
  const seen = entry.lastSeenAt === null ? NaN : Date.parse(entry.lastSeenAt)
  const stale =
    entry.state === 'running' && Number.isFinite(seen) && serverTime - seen > REACH_SEEN_WITHIN_MS
  const online = entry.state === 'running' && serverTime - seen <= REACH_SEEN_WITHIN_MS
  const why = stale
    ? 'stale-heartbeat'
    : !online
      ? 'offline'
      : !entry.machineReach
        ? 'reach-off'
        : !entry.machineGrants
          ? 'not-enrolled'
          : !entry.reachable
            ? 'offline'
            : undefined
  return {
    id: entry.id,
    label: entry.label,
    online,
    hostVersion: entry.hostVersion,
    catalogOps: 'unknown',
    ready: why === undefined,
    ...(why ? { why } : {}),
  }
}

/** Control's answer as the dispatcher reads it: reach off here lists no machines. */
export function readDirectory(response: MachineDirectoryResponse): ReachDirectory {
  if (!response.self.machineReach) return unavailable('reach-off')
  const serverTime = Date.parse(response.serverTime)
  return {
    available: true,
    self: { id: response.self.id, label: response.self.label },
    machines: response.machines.map((entry) => machine(entry, serverTime)),
  }
}

export function createReachDirectory(ports: ReachControlPorts) {
  const now = ports.now ?? Date.now
  const request = createReachRequester(ports)
  let cached: { at: number; hostId: string; value: ReachDirectory } | null = null
  let flight: { hostId: string; promise: Promise<ReachDirectory> } | null = null

  async function load(control: ReachControl, budget?: ReachBudget): Promise<ReachDirectory> {
    try {
      const response = await request(
        control,
        {
          method: 'GET',
          path: CONTROL_MACHINE_ROUTES.hostMachines,
          body: '',
          parse: parseMachineDirectoryResponse,
        },
        budget,
      )
      const value = readDirectory(response)
      cached = { at: now(), hostId: control.hostId, value }
      return value
    } catch (error) {
      const reason = failureReason(error)
      // An older control plane stays older for a while; a failed request does not.
      if (reason === 'control-old')
        cached = { at: now(), hostId: control.hostId, value: unavailable(reason) }
      return unavailable(reason)
    }
  }

  return {
    read(options: ReachBudget & { readonly fresh?: boolean } = {}): Promise<ReachDirectory> {
      const control = ports.control()
      if (!control) return Promise.resolve(unavailable('signed-out'))
      if (
        !options.fresh &&
        cached?.hostId === control.hostId &&
        now() - cached.at < REACH_DIRECTORY_TTL_MS
      )
        return Promise.resolve(cached.value)
      // Scoped requests must never inherit another caller’s cancellation or deadline.
      if (options.signal || options.deadlineAt !== undefined) return load(control, options)
      if (flight?.hostId === control.hostId) return flight.promise
      const promise = load(control).finally(() => {
        if (flight?.promise === promise) flight = null
      })
      flight = { hostId: control.hostId, promise }
      return promise
    },
    clear() {
      cached = null
    },
  }
}

export type ReachDirectoryCache = ReturnType<typeof createReachDirectory>
