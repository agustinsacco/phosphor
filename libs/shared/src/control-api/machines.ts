/**
 * Machine bodies: the machine list and its entries, renames, the signed-in
 * account, a Host's own record and the heartbeat. Parsers keep known fields
 * only, and a nullable field must be present: null and missing differ.
 */

import { CONTROL_LIMITS } from './constants'
import {
  account,
  fail,
  isCount,
  isEndpoint,
  isHostname,
  isIso,
  isRecord,
  isUuid,
  isVersion,
  lanes,
  normalizeLabel,
  ok,
  oneOf,
  optional,
  readiness,
  type Parsed,
} from './fields'
import { parseRevoked } from './grants'
import { isKeyFingerprint } from './signing'
import {
  ARCHES,
  PLATFORMS,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type HostSelfResponse,
  type MachineRenameRequest,
  type MachinesResponse,
  type MachineView,
  type MeResponse,
} from './types'

export function parseMachineRenameRequest(value: unknown): Parsed<MachineRenameRequest> {
  const label = isRecord(value) ? normalizeLabel(value.label) : null
  return label === null ? fail('label') : ok({ label })
}

export function parseMachineView(value: unknown): Parsed<MachineView> {
  if (!isRecord(value)) return fail('machine must be an object')
  const label = normalizeLabel(value.label)
  if (!isUuid(value.id)) return fail('id')
  if (label === null || label !== value.label) return fail('label')
  if (!isHostname(value.hostname)) return fail('hostname')
  if (!oneOf(PLATFORMS, value.platform)) return fail('platform')
  if (!oneOf(ARCHES, value.arch)) return fail('arch')
  const hostVersion = optional(value.hostVersion, isVersion)
  if (hostVersion === undefined) return fail('hostVersion')
  if (!isKeyFingerprint(value.keyFingerprint)) return fail('keyFingerprint')
  if (!isIso(value.enrolledAt)) return fail('enrolledAt')
  const lastSeenAt = optional(value.lastSeenAt, isIso)
  if (lastSeenAt === undefined) return fail('lastSeenAt')
  const state =
    value.state === null
      ? null
      : oneOf(['running', 'stopping'] as const, value.state)
        ? value.state
        : undefined
  if (state === undefined) return fail('state')
  const ready = value.readiness === null ? null : readiness(value.readiness)
  if (ready === null && value.readiness !== null) return fail('readiness')
  const counts = value.lanes === null ? null : lanes(value.lanes)
  if (counts === null && value.lanes !== null) return fail('lanes')
  const endpoint = optional(value.endpoint, isEndpoint)
  if (endpoint === undefined) return fail('endpoint')
  return ok({
    id: value.id,
    label,
    hostname: value.hostname,
    platform: value.platform,
    arch: value.arch,
    hostVersion,
    keyFingerprint: value.keyFingerprint,
    enrolledAt: value.enrolledAt,
    lastSeenAt,
    state,
    readiness: ready,
    lanes: counts,
    endpoint,
  })
}

export function parseMachinesResponse(value: unknown): Parsed<MachinesResponse> {
  if (!isRecord(value) || !Array.isArray(value.machines)) return fail('machines')
  if (!isIso(value.serverTime)) return fail('serverTime')
  if (value.machines.length > CONTROL_LIMITS.maxHostsPerAccount * 5) return fail('machines')
  const machines: MachineView[] = []
  for (const entry of value.machines) {
    const parsed = parseMachineView(entry)
    if (!parsed.ok) return fail(`machines: ${parsed.reason}`)
    machines.push(parsed.value)
  }
  return ok({ machines, serverTime: value.serverTime })
}

export function parseMeResponse(value: unknown): Parsed<MeResponse> {
  if (!isRecord(value)) return fail('body must be an object')
  const handle = account(value.account)
  if (!handle) return fail('account')
  if (typeof value.enabled !== 'boolean') return fail('enabled')
  if (!isCount(value.maxHosts, 10_000)) return fail('maxHosts')
  return ok({ account: handle, enabled: value.enabled, maxHosts: value.maxHosts })
}

export function parseHostSelfResponse(value: unknown): Parsed<HostSelfResponse> {
  if (!isRecord(value)) return fail('body must be an object')
  const label = normalizeLabel(value.label)
  const owner = account(value.owner)
  if (!isUuid(value.hostId)) return fail('hostId')
  if (label === null || label !== value.label) return fail('label')
  if (!owner) return fail('owner')
  if (!isIso(value.enrolledAt)) return fail('enrolledAt')
  const lastSeenAt = optional(value.lastSeenAt, isIso)
  if (lastSeenAt === undefined) return fail('lastSeenAt')
  return ok({ hostId: value.hostId, label, owner, enrolledAt: value.enrolledAt, lastSeenAt })
}

export function parseHeartbeatRequest(value: unknown): Parsed<HeartbeatRequest> {
  if (!isRecord(value)) return fail('body must be an object')
  if (!isCount(value.seq, Number.MAX_SAFE_INTEGER) || value.seq < 1) return fail('seq')
  if (!oneOf(['running', 'stopping'] as const, value.state)) return fail('state')
  if (!isVersion(value.hostVersion)) return fail('hostVersion')
  if (!isCount(value.uptimeSec, 10 * 366 * 86_400)) return fail('uptimeSec')
  const ready = readiness(value.readiness)
  if (!ready) return fail('readiness')
  const counts = lanes(value.lanes)
  if (!counts) return fail('lanes')
  const endpoint = optional(value.endpoint, isEndpoint)
  if (endpoint === undefined) return fail('endpoint')
  return ok({
    seq: value.seq,
    state: value.state,
    hostVersion: value.hostVersion,
    uptimeSec: value.uptimeSec,
    readiness: ready,
    lanes: counts,
    endpoint,
  })
}

export function parseHeartbeatResponse(value: unknown): Parsed<HeartbeatResponse> {
  if (!isRecord(value) || value.accepted !== true) return fail('accepted')
  if (!isCount(value.nextInSec, 3600) || value.nextInSec < CONTROL_LIMITS.heartbeatMinSec)
    return fail('nextInSec')
  if (value.epoch !== undefined && (!isCount(value.epoch, 2147483647) || value.epoch < 1))
    return fail('epoch')
  if (value.ownerId !== undefined && !isUuid(value.ownerId)) return fail('ownerId')
  const revoked = value.revoked === undefined ? undefined : parseRevoked(value.revoked)
  if (revoked === null) return fail('revoked')
  return ok({
    accepted: true,
    nextInSec: value.nextInSec,
    ...(value.epoch !== undefined ? { epoch: value.epoch } : {}),
    ...(value.ownerId !== undefined ? { ownerId: value.ownerId } : {}),
    ...(revoked !== undefined ? { revoked } : {}),
  })
}
