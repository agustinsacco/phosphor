/**
 * The control plane's wire contract: phosphor.saccolabs.com/api/v1, shared by
 * its server (apps/control), Hosts (apps/host), Desktop and later the PWA.
 *
 * The control plane knows who you are, which machines you have and whether
 * they are up. It never sees lanes, prompts, transcripts, paths or provider
 * tokens. Lanes travel from a machine to a client over Tailscale, never here.
 *
 * Pure on purpose: no node:, no electron, no fetch, no crypto. Hashing,
 * signing and transport live at each edge; this module only fixes the shapes,
 * limits and byte-exact strings both sides must agree on.
 *
 * Parsers keep known fields only and ignore unknown ones, so a newer peer can
 * add a field without breaking an older one, and nothing unknown is stored.
 */

import { GRANT_LIMITS, GRANT_PREFIX } from './host-grant'
import {
  CONTROL_ERROR_STATUS,
  CONTROL_LIMITS,
  type ControlErrorBody,
  type ControlErrorCode,
} from './control-api/constants'
import { normalizeUserCode } from './control-api/codes'
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
} from './control-api/fields'
import { isKeyFingerprint, isPublicKey } from './control-api/signing'
import {
  ARCHES,
  PLATFORMS,
  type ClientRegisterRequest,
  type ClientRegisterResponse,
  type EnrollmentApproveRequest,
  type EnrollmentApproveResponse,
  type EnrollmentCreateRequest,
  type EnrollmentCreateResponse,
  type EnrollmentLookupRequest,
  type EnrollmentLookupResponse,
  type EnrollmentPollRequest,
  type EnrollmentPollResponse,
  type GrantIssueRequest,
  type GrantIssueResponse,
  type HealthResponse,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type HostRevocations,
  type HostSelfResponse,
  type MachineRenameRequest,
  type MachinesResponse,
  type MachineView,
  type MeResponse,
} from './control-api/types'

export {
  CONTROL_API_PREFIX,
  CONTROL_API_VERSION,
  CONTROL_ERROR_STATUS,
  CONTROL_LIMITS,
  CONTROL_ROUTES,
  CONTROL_TRACE_HEADERS,
  DEFAULT_CONTROL_URL,
  isControlClient,
  isControlTrace,
  machineRoute,
} from './control-api/constants'
export type { ControlErrorBody, ControlErrorCode } from './control-api/constants'
export {
  HOST_HEADERS,
  HOST_SIGNATURE_SCHEME,
  formatKeyFingerprint,
  hostSigningString,
  isKeyFingerprint,
  isNonce,
  isPublicKey,
  isSha256Hex,
  isSignature,
  parseTimestamp,
  withinSkew,
} from './control-api/signing'
export type { HostSigningInput } from './control-api/signing'
export {
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
  formatUserCode,
  normalizeUserCode,
  userCodeFromBytes,
} from './control-api/codes'
export { ARCHES, PLATFORMS } from './control-api/types'
export type {
  AccountHandle,
  Arch,
  ClientRegisterRequest,
  ClientRegisterResponse,
  EnrollmentApproveRequest,
  EnrollmentApproveResponse,
  EnrollmentCreateRequest,
  EnrollmentCreateResponse,
  EnrollmentLookupRequest,
  EnrollmentLookupResponse,
  EnrollmentPollRequest,
  EnrollmentPollResponse,
  GrantIssueRequest,
  GrantIssueResponse,
  HealthResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  HostRevocations,
  HostSelfResponse,
  LaneCounts,
  MachineRenameRequest,
  MachineState,
  MachinesResponse,
  MachineView,
  MeResponse,
  Platform,
  Readiness,
} from './control-api/types'
export {
  isEndpoint,
  isHostname,
  isIsoTime,
  isUuid,
  isVersion,
  normalizeLabel,
} from './control-api/fields'
export type { Parsed } from './control-api/fields'

export function parseEnrollmentCreateRequest(value: unknown): Parsed<EnrollmentCreateRequest> {
  if (!isRecord(value)) return fail('body must be an object')
  if (!isPublicKey(value.publicKey)) return fail('publicKey')
  if (!isHostname(value.hostname)) return fail('hostname')
  if (!oneOf(PLATFORMS, value.platform)) return fail('platform')
  if (!oneOf(ARCHES, value.arch)) return fail('arch')
  if (!isVersion(value.hostVersion)) return fail('hostVersion')
  return ok({
    publicKey: value.publicKey,
    hostname: value.hostname,
    platform: value.platform,
    arch: value.arch,
    hostVersion: value.hostVersion,
  })
}

export function parseEnrollmentCreateResponse(value: unknown): Parsed<EnrollmentCreateResponse> {
  if (!isRecord(value)) return fail('body must be an object')
  if (!isUuid(value.enrollmentId)) return fail('enrollmentId')
  const userCode = normalizeUserCode(value.userCode)
  if (userCode === null || userCode !== value.userCode) return fail('userCode')
  if (!isKeyFingerprint(value.keyFingerprint)) return fail('keyFingerprint')
  if (!isIso(value.expiresAt)) return fail('expiresAt')
  if (!isCount(value.pollIntervalSec, 60) || value.pollIntervalSec < 1)
    return fail('pollIntervalSec')
  return ok({
    enrollmentId: value.enrollmentId,
    userCode,
    keyFingerprint: value.keyFingerprint,
    expiresAt: value.expiresAt,
    pollIntervalSec: value.pollIntervalSec,
  })
}

export function parseEnrollmentPollRequest(value: unknown): Parsed<EnrollmentPollRequest> {
  if (!isRecord(value) || !isUuid(value.enrollmentId)) return fail('enrollmentId')
  return ok({ enrollmentId: value.enrollmentId })
}

export function parseEnrollmentPollResponse(value: unknown): Parsed<EnrollmentPollResponse> {
  if (!isRecord(value)) return fail('body must be an object')
  if (value.status === 'pending' || value.status === 'expired') return ok({ status: value.status })
  if (value.status !== 'approved') return fail('status')
  const label = normalizeLabel(value.label)
  const owner = account(value.owner)
  if (!isUuid(value.hostId)) return fail('hostId')
  if (label === null || label !== value.label) return fail('label')
  if (!owner) return fail('owner')
  return ok({ status: 'approved', hostId: value.hostId, label, owner })
}

export function parseEnrollmentLookupRequest(value: unknown): Parsed<EnrollmentLookupRequest> {
  const code = isRecord(value) ? normalizeUserCode(value.userCode) : null
  return code ? ok({ userCode: code }) : fail('userCode')
}

export function parseEnrollmentLookupResponse(value: unknown): Parsed<EnrollmentLookupResponse> {
  if (!isRecord(value)) return fail('body must be an object')
  if (!isHostname(value.hostname)) return fail('hostname')
  if (!oneOf(PLATFORMS, value.platform)) return fail('platform')
  if (!oneOf(ARCHES, value.arch)) return fail('arch')
  if (!isVersion(value.hostVersion)) return fail('hostVersion')
  if (!isKeyFingerprint(value.keyFingerprint)) return fail('keyFingerprint')
  if (!isIso(value.expiresAt)) return fail('expiresAt')
  return ok({
    hostname: value.hostname,
    platform: value.platform,
    arch: value.arch,
    hostVersion: value.hostVersion,
    keyFingerprint: value.keyFingerprint,
    expiresAt: value.expiresAt,
  })
}

export function parseEnrollmentApproveRequest(value: unknown): Parsed<EnrollmentApproveRequest> {
  if (!isRecord(value)) return fail('body must be an object')
  const code = normalizeUserCode(value.userCode)
  const label = normalizeLabel(value.label)
  if (!code) return fail('userCode')
  if (label === null) return fail('label')
  return ok({ userCode: code, label })
}

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

export function parseEnrollmentApproveResponse(value: unknown): Parsed<EnrollmentApproveResponse> {
  if (!isRecord(value)) return fail('body must be an object')
  const machine = parseMachineView(value.machine)
  return machine.ok ? ok({ machine: machine.value }) : fail(`machine: ${machine.reason}`)
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

export function parseHealthResponse(value: unknown): Parsed<HealthResponse> {
  if (!isRecord(value) || value.ok !== true) return fail('ok')
  if (typeof value.version !== 'string' || value.version.length > 100) return fail('version')
  if (typeof value.configured !== 'boolean') return fail('configured')
  return ok({ ok: true, version: value.version, configured: value.configured })
}

/** Own keys only: 'constructor' or 'toString' are not error codes. */
export const isControlErrorCode = (value: unknown): value is ControlErrorCode =>
  typeof value === 'string' && Object.hasOwn(CONTROL_ERROR_STATUS, value)

/** A server error body, or null if the bytes were not one. Messages are capped for display. */
export function parseControlError(value: unknown): ControlErrorBody | null {
  if (!isRecord(value) || !isRecord(value.error)) return null
  const { code, message } = value.error
  if (!isControlErrorCode(code) || typeof message !== 'string') return null
  return { error: { code, message: message.slice(0, 300) } }
}

// ---------------------------------------------------------------------- Status

export type MachineStatus = 'up' | 'down' | 'never-seen'

/**
 * Up or down, judged on the client: the server only records beats, so a
 * machine that stops beating is noticed by the absence of updates.
 * `clockOffsetMs` = serverTime - local time when the list was fetched.
 */
export function machineStatus(
  machine: Pick<MachineView, 'lastSeenAt' | 'state'>,
  nowMs: number,
  clockOffsetMs = 0,
): MachineStatus {
  if (machine.lastSeenAt === null) return 'never-seen'
  if (machine.state !== 'running') return 'down'
  const age = nowMs + clockOffsetMs - Date.parse(machine.lastSeenAt)
  return age <= CONTROL_LIMITS.downAfterSec * 1000 ? 'up' : 'down'
}

// ---------------------------------------------------------- Clients and grants

export function parseClientRegisterRequest(value: unknown): Parsed<ClientRegisterRequest> {
  const label = isRecord(value) ? normalizeLabel(value.label) : null
  return label === null ? fail('label') : ok({ label })
}
export function parseClientRegisterResponse(value: unknown): Parsed<ClientRegisterResponse> {
  if (!isRecord(value) || !isRecord(value.client) || !isUuid(value.client.id)) return fail('client')
  const label = normalizeLabel(value.client.label)
  if (label === null || label !== value.client.label) return fail('label')
  return ok({ client: { id: value.client.id, label } })
}
export function parseGrantIssueRequest(value: unknown): Parsed<GrantIssueRequest> {
  if (!isRecord(value) || !isUuid(value.hostId) || !isUuid(value.clientId)) return fail('ids')
  return ok({ hostId: value.hostId, clientId: value.clientId })
}
export function parseGrantIssueResponse(value: unknown): Parsed<GrantIssueResponse> {
  if (!isRecord(value) || !isRecord(value.host)) return fail('body')
  if (
    typeof value.grant !== 'string' ||
    value.grant.length > GRANT_LIMITS.tokenChars ||
    !value.grant.startsWith(GRANT_PREFIX) ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/.test(value.grant.slice(GRANT_PREFIX.length))
  )
    return fail('grant')
  if (!isIso(value.expiresAt)) return fail('expiresAt')
  if (!isUuid(value.host.id) || !isPublicKey(value.host.publicKey)) return fail('host')
  const endpoint = optional(value.host.endpoint, isEndpoint)
  if (endpoint === undefined) return fail('endpoint')
  return ok({
    grant: value.grant,
    expiresAt: value.expiresAt,
    host: { id: value.host.id, endpoint, publicKey: value.host.publicKey },
  })
}
function parseRevoked(value: unknown): HostRevocations['revoked'] | null {
  if (!isRecord(value)) return null
  const lists: string[][] = []
  for (const list of [value.sessions, value.clients]) {
    if (!Array.isArray(list) || list.length > GRANT_LIMITS.revocations) return null
    const ids: string[] = []
    for (const id of list) {
      if (!isUuid(id)) return null
      ids.push(id)
    }
    lists.push(ids)
  }
  const [sessions, clients] = lists
  return sessions && clients ? { sessions, clients } : null
}
export function parseHostRevocations(value: unknown): Parsed<HostRevocations> {
  if (!isRecord(value) || !isUuid(value.ownerId)) return fail('ownerId')
  if (!isCount(value.epoch, 2147483647) || value.epoch < 1) return fail('epoch')
  const revoked = parseRevoked(value.revoked)
  return revoked ? ok({ ownerId: value.ownerId, epoch: value.epoch, revoked }) : fail('revoked')
}
