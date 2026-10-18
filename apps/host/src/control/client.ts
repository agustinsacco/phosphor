import { randomBytes, type KeyObject } from 'node:crypto'
import {
  isControlTrace,
  CONTROL_ROUTES,
  isPublicKey,
  isUuid,
  parseEnrollmentCreateRequest,
  parseEnrollmentCreateResponse,
  parseEnrollmentPollRequest,
  parseEnrollmentPollResponse,
  parseHostSelfResponse,
  parseHeartbeatRequest,
  parseHeartbeatResponse,
  type HeartbeatRequest,
  type EnrollmentCreateRequest,
} from '@phosphor/shared/control-api'
import { isControlUrl } from './url'
import { executeRequest, type ClientPorts, type ClientState } from './client-request'
import { ControlFailure } from './client-response'

export { ControlFailure } from './client-response'
export type { ClientPorts } from './client-request'

export function createControlClient(url: string, ports: ClientPorts = {}) {
  const trace = isControlTrace(ports.trace) ? ports.trace : randomBytes(8).toString('hex')
  if (!isControlUrl(url)) throw new ControlFailure('bad-request')
  const state: ClientState = { url, trace, ports }
  return {
    enroll: (body: EnrollmentCreateRequest, key: KeyObject) => enroll(state, body, key),
    poll: (enrollmentId: string, publicKey: string, key: KeyObject) =>
      poll(state, enrollmentId, publicKey, key),
    self: (hostId: string, key: KeyObject) => self(state, hostId, key),
    heartbeat: (hostId: string, key: KeyObject, body: HeartbeatRequest, signal?: AbortSignal) =>
      heartbeat(state, hostId, key, body, signal),
    revoke: (hostId: string, key: KeyObject) => revoke(state, hostId, key),
  }
}

async function enroll(state: ClientState, body: EnrollmentCreateRequest, key: KeyObject) {
  const parsed = parseEnrollmentCreateRequest(body)
  if (!parsed.ok) throw new ControlFailure('bad-request')
  return executeRequest(state, {
    method: 'POST',
    path: CONTROL_ROUTES.enrollments,
    identity: { publicKey: body.publicKey },
    key,
    body: JSON.stringify(parsed.value),
    parse: parseEnrollmentCreateResponse,
  })
}

async function poll(state: ClientState, enrollmentId: string, publicKey: string, key: KeyObject) {
  const parsed = parseEnrollmentPollRequest({ enrollmentId })
  if (!parsed.ok || !isPublicKey(publicKey)) throw new ControlFailure('bad-request')
  return executeRequest(state, {
    method: 'POST',
    path: CONTROL_ROUTES.enrollmentPoll,
    identity: { publicKey },
    key,
    body: JSON.stringify(parsed.value),
    parse: parseEnrollmentPollResponse,
  })
}

async function self(state: ClientState, hostId: string, key: KeyObject) {
  if (!isUuid(hostId)) throw new ControlFailure('bad-request')
  const result = await executeRequest(state, {
    method: 'GET',
    path: CONTROL_ROUTES.hostSelf,
    identity: { hostId },
    key,
    body: '',
    parse: parseHostSelfResponse,
  })
  if (result.hostId !== hostId) throw new ControlFailure('internal')
  return result
}

function heartbeat(
  state: ClientState,
  hostId: string,
  key: KeyObject,
  body: HeartbeatRequest,
  signal?: AbortSignal,
) {
  const parsed = parseHeartbeatRequest(body)
  if (!isUuid(hostId) || !parsed.ok) throw new ControlFailure('bad-request')
  return executeRequest(state, {
    method: 'POST',
    path: CONTROL_ROUTES.hostHeartbeat,
    identity: { hostId },
    key,
    body: JSON.stringify(parsed.value),
    parse: parseHeartbeatResponse,
    signal,
    seq: parsed.value.seq,
  })
}

function revoke(state: ClientState, hostId: string, key: KeyObject) {
  if (!isUuid(hostId)) throw new ControlFailure('bad-request')
  return executeRequest(state, {
    method: 'POST',
    path: CONTROL_ROUTES.hostRevoke,
    identity: { hostId },
    key,
    body: '{}',
    parse: () => ({ ok: true, value: undefined }),
    empty: true,
  })
}

export type ControlClient = ReturnType<typeof createControlClient>
