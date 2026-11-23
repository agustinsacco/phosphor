/**
 * Machine reach: one enrolled Host asking control for a grant to a sibling, the
 * sibling directory it chooses from, and the owner's per-machine reach switch.
 * Routes stay apart from CONTROL_ROUTES so the route inventory tests that pin
 * the v1 table never move. Reached through `../control-api`.
 */

import { CONTROL_API_PREFIX, CONTROL_LIMITS, machineRoute } from './constants'
import {
  fail,
  isIso,
  isRecord,
  isUuid,
  isVersion,
  normalizeLabel,
  ok,
  oneOf,
  optional,
  readiness,
  type Parsed,
} from './fields'
import type { GrantIssueResponse, MachineState, Readiness } from './types'

export const CONTROL_MACHINE_ROUTES = {
  /** GET, Host-signed, empty body: the caller's siblings (`MachineDirectoryResponse`). */
  hostMachines: `${CONTROL_API_PREFIX}/hosts/self/machines`,
  /** POST, Host-signed: `MachineGrantIssueRequest` answered as `GrantIssueResponse`. */
  hostMachineGrants: `${CONTROL_API_PREFIX}/hosts/self/machine-grants`,
} as const

/** PATCH `MachineReachRequest`, user-authenticated; answers `MachineReachResponse`. */
export const machineReachRoute = (machineId: string): string => `${machineRoute(machineId)}/reach`

export interface MachineGrantIssueRequest {
  readonly targetHostId: string
}
/** A machine grant: `origin: 'machine'`, the caller's id in `machine`, and no caps. */
export type MachineGrantIssueResponse = GrantIssueResponse

export interface MachineDirectoryEntry {
  readonly id: string
  readonly label: string
  readonly hostVersion: string | null
  readonly lastSeenAt: string | null
  readonly state: MachineState | null
  readonly readiness: Readiness | null
  /** The target's last beat said it accepts machine grants. */
  readonly machineGrants: boolean
  readonly machineReach: boolean
  /** The target has an endpoint, so a grant to it can be used. */
  readonly reachable: boolean
}
export interface MachineDirectoryResponse {
  readonly self: { readonly id: string; readonly label: string; readonly machineReach: boolean }
  /** With the caller's reach off, empty. */
  readonly machines: readonly MachineDirectoryEntry[]
  readonly serverTime: string
}
export interface MachineReachRequest {
  readonly enabled: boolean
}
export interface MachineReachResponse {
  readonly machineReach: boolean
}

export function parseMachineGrantIssueRequest(value: unknown): Parsed<MachineGrantIssueRequest> {
  return isRecord(value) && isUuid(value.targetHostId)
    ? ok({ targetHostId: value.targetHostId })
    : fail('targetHostId')
}

export function parseMachineReachRequest(value: unknown): Parsed<MachineReachRequest> {
  return isRecord(value) && typeof value.enabled === 'boolean'
    ? ok({ enabled: value.enabled })
    : fail('enabled')
}

export function parseMachineReachResponse(value: unknown): Parsed<MachineReachResponse> {
  return isRecord(value) && typeof value.machineReach === 'boolean'
    ? ok({ machineReach: value.machineReach })
    : fail('machineReach')
}

function label(value: unknown): string | null {
  const normalized = normalizeLabel(value)
  return normalized !== null && normalized === value ? normalized : null
}

function directoryEntry(value: unknown): MachineDirectoryEntry | null {
  if (!isRecord(value) || !isUuid(value.id)) return null
  const name = label(value.label)
  const hostVersion = optional(value.hostVersion, isVersion)
  const lastSeenAt = optional(value.lastSeenAt, isIso)
  const state =
    value.state === null
      ? null
      : oneOf(['running', 'stopping'] as const, value.state)
        ? value.state
        : undefined
  const ready = value.readiness === null ? null : readiness(value.readiness)
  if (
    name === null ||
    hostVersion === undefined ||
    lastSeenAt === undefined ||
    state === undefined ||
    (ready === null && value.readiness !== null) ||
    typeof value.machineGrants !== 'boolean' ||
    typeof value.machineReach !== 'boolean' ||
    typeof value.reachable !== 'boolean'
  )
    return null
  return {
    id: value.id,
    label: name,
    hostVersion,
    lastSeenAt,
    state,
    readiness: ready,
    machineGrants: value.machineGrants,
    machineReach: value.machineReach,
    reachable: value.reachable,
  }
}

export function parseMachineDirectoryResponse(value: unknown): Parsed<MachineDirectoryResponse> {
  if (!isRecord(value) || !isRecord(value.self)) return fail('self')
  const selfLabel = label(value.self.label)
  if (!isUuid(value.self.id) || selfLabel === null || typeof value.self.machineReach !== 'boolean')
    return fail('self')
  if (!isIso(value.serverTime)) return fail('serverTime')
  if (!Array.isArray(value.machines) || value.machines.length > CONTROL_LIMITS.maxHostsPerAccount)
    return fail('machines')
  const machines: MachineDirectoryEntry[] = []
  for (const entry of value.machines) {
    const parsed = directoryEntry(entry)
    if (!parsed) return fail('machines')
    machines.push(parsed)
  }
  return ok({
    self: { id: value.self.id, label: selfLabel, machineReach: value.self.machineReach },
    machines,
    serverTime: value.serverTime,
  })
}
