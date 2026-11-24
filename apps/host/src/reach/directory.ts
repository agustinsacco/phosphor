/**
 * Machine reach, caller side: this daemon's sibling directory from control
 * (`GET /hosts/self/machines`, signed with the machine key), cached 30 seconds
 * and single-flight. A 404 is an older control plane. Living contract:
 * docs/agent-control.md ("Machines").
 */
import type { KeyObject } from 'node:crypto'
import {
  CONTROL_MACHINE_ROUTES,
  parseMachineDirectoryResponse,
  type MachineDirectoryEntry,
  type MachineDirectoryResponse,
} from '@phosphor/shared/control-api'
import type {
  ReachDirectory,
  ReachMachine,
  ReachUnavailable,
} from '@phosphor/session-runtime/ops/reach'
import { executeRequest, type ClientPorts, type RequestArgs } from '../control/client-request'
import { ControlFailure } from '../control/client-response'

export const REACH_DIRECTORY_TTL_MS = 30_000
/** Control refuses a grant to a target last seen longer ago than this. */
export const REACH_SEEN_WITHIN_MS = 90_000

/** The enrolled machine that signs reach requests; null before enrollment. */
export interface ReachControl {
  readonly url: string
  readonly hostId: string
  readonly key: KeyObject
}

export interface ReachControlPorts {
  readonly control: () => ReachControl | null
  readonly fetch?: ClientPorts['fetch']
  readonly now?: () => number
  readonly log?: ClientPorts['log']
  readonly trace?: string
}

/** One signed request to control with the reach ports' identity. */
export function reachRequest<T>(
  ports: ReachControlPorts,
  control: ReachControl,
  args: Omit<RequestArgs<T>, 'identity' | 'key'>,
): Promise<T> {
  const state = {
    url: control.url,
    trace: ports.trace ?? 'reach',
    ports: { fetch: ports.fetch, now: ports.now, log: ports.log },
  }
  return executeRequest(state, { ...args, identity: { hostId: control.hostId }, key: control.key })
}

function unavailable(reason: ReachUnavailable): ReachDirectory {
  return { available: false, reason }
}

function failureReason(error: unknown): ReachUnavailable {
  if (!(error instanceof ControlFailure)) return 'offline'
  if (error.code === 'not-found') return 'control-old'
  if (error.code === 'gone' || error.code === 'unauthenticated') return 'signed-out'
  if (error.code === 'forbidden') return 'account-disabled'
  return 'offline'
}

function machine(entry: MachineDirectoryEntry, serverTime: number): ReachMachine {
  const seen = entry.lastSeenAt === null ? NaN : Date.parse(entry.lastSeenAt)
  const online = entry.state === 'running' && serverTime - seen <= REACH_SEEN_WITHIN_MS
  const why = !online
    ? 'offline'
    : !entry.machineReach
      ? 'reach-off'
      : !entry.machineGrants
        ? 'update-host'
        : !entry.reachable
          ? 'offline'
          : undefined
  return {
    id: entry.id,
    label: entry.label,
    online,
    hostVersion: entry.hostVersion,
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
  let cached: { at: number; hostId: string; value: ReachDirectory } | null = null
  let flight: { hostId: string; promise: Promise<ReachDirectory> } | null = null

  async function load(control: ReachControl): Promise<ReachDirectory> {
    try {
      const response = await reachRequest(ports, control, {
        method: 'GET',
        path: CONTROL_MACHINE_ROUTES.hostMachines,
        body: '',
        parse: parseMachineDirectoryResponse,
      })
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
    read(options: { readonly fresh?: boolean } = {}): Promise<ReachDirectory> {
      const control = ports.control()
      if (!control) return Promise.resolve(unavailable('signed-out'))
      if (
        !options.fresh &&
        cached?.hostId === control.hostId &&
        now() - cached.at < REACH_DIRECTORY_TTL_MS
      )
        return Promise.resolve(cached.value)
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
