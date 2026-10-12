import { randomBytes, type KeyObject } from 'node:crypto'
import {
  CONTROL_ERROR_STATUS,
  CONTROL_ROUTES,
  isPublicKey,
  isUuid,
  parseControlError,
  parseEnrollmentCreateRequest,
  parseEnrollmentCreateResponse,
  parseEnrollmentPollRequest,
  parseEnrollmentPollResponse,
  parseHostSelfResponse,
  parseHeartbeatRequest,
  parseHeartbeatResponse,
  type HeartbeatRequest,
  type ControlErrorCode,
  type EnrollmentCreateRequest,
  type Parsed,
} from '@phosphor/shared/control-api'
import { signRequest, type SigningIdentity } from './signer'
import { isControlUrl } from './url'

export class ControlFailure extends Error {
  constructor(readonly code: ControlErrorCode | 'offline') {
    // Do not echo server messages, transport errors or response bytes.
    super(
      code === 'offline'
        ? 'The control plane could not be reached.'
        : `Control request failed (${code}).`,
    )
  }
}

export interface ClientPorts {
  fetch?: typeof fetch
  now?: () => number
  random?: (size: number) => Uint8Array
  signal?: AbortSignal
}

export function createControlClient(url: string, ports: ClientPorts = {}) {
  if (!isControlUrl(url)) throw new ControlFailure('bad-request')
  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    identity: SigningIdentity,
    key: KeyObject,
    body: string,
    parse: (value: unknown) => Parsed<T>,
    empty = false,
    signal = ports.signal,
  ): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    const timer = setTimeout(abort, 10_000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    try {
      const response = await (ports.fetch ?? fetch)(`${url}${path}`, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...signRequest({
            method,
            path,
            identity,
            body,
            key,
            now: ports.now ?? Date.now,
            random: ports.random ?? randomBytes,
          }),
        },
        ...(method === 'POST' ? { body } : {}),
      })
      // Unknown and removed Hosts are indistinguishable, even with a broken error body.
      if (response.status === 410) {
        await response.body?.cancel().catch(() => {})
        throw new ControlFailure('gone')
      }
      if (empty && response.status === 204) {
        const length = response.headers.get('content-length')
        if ((length !== null && length !== '0') || response.headers.has('transfer-encoding')) {
          throw new ControlFailure('internal')
        }
        if (response.body === null) return parseEmpty(parse)
      }
      const invalidError = () =>
        new ControlFailure(
          !response.ok && response.status === 429
            ? 'too-many-requests'
            : !response.ok && response.status >= 500
              ? 'unavailable'
              : 'internal',
        )
      if (!response.body) throw invalidError()
      const reader = response.body.getReader()
      const bytes = Buffer.alloc(64 * 1024)
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 64 * 1024) throw new ControlFailure('payload-too-large')
          bytes.set(chunk.value, size - chunk.value.byteLength)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      if (empty && response.status === 204 && size === 0) return parseEmpty(parse)
      if (!(response.headers.get('content-type') ?? '').match(/^application\/json(?:;|$)/i)) {
        throw invalidError()
      }
      let value: unknown
      try {
        value = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)),
        )
      } catch {
        throw invalidError()
      }
      if (!response.ok) {
        const parsed = parseControlError(value)
        if (!parsed || CONTROL_ERROR_STATUS[parsed.error.code] !== response.status) {
          throw invalidError()
        }
        throw new ControlFailure(parsed.error.code)
      }
      if (empty || response.status !== 200) throw new ControlFailure('internal')
      const parsed = parse(value)
      if (!parsed.ok) throw new ControlFailure('internal')
      return parsed.value
    } catch (error) {
      if (error instanceof ControlFailure) throw error
      throw new ControlFailure('offline')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
  return {
    async enroll(body: EnrollmentCreateRequest, key: KeyObject) {
      const parsed = parseEnrollmentCreateRequest(body)
      if (!parsed.ok) throw new ControlFailure('bad-request')
      return request(
        'POST',
        CONTROL_ROUTES.enrollments,
        { publicKey: body.publicKey },
        key,
        JSON.stringify(parsed.value),
        parseEnrollmentCreateResponse,
      )
    },
    async poll(enrollmentId: string, publicKey: string, key: KeyObject) {
      const parsed = parseEnrollmentPollRequest({ enrollmentId })
      if (!parsed.ok || !isPublicKey(publicKey)) throw new ControlFailure('bad-request')
      return request(
        'POST',
        CONTROL_ROUTES.enrollmentPoll,
        { publicKey },
        key,
        JSON.stringify(parsed.value),
        parseEnrollmentPollResponse,
      )
    },
    async self(hostId: string, key: KeyObject) {
      if (!isUuid(hostId)) throw new ControlFailure('bad-request')
      const self = await request(
        'GET',
        CONTROL_ROUTES.hostSelf,
        { hostId },
        key,
        '',
        parseHostSelfResponse,
      )
      if (self.hostId !== hostId) throw new ControlFailure('internal')
      return self
    },
    heartbeat(hostId: string, key: KeyObject, body: HeartbeatRequest, signal?: AbortSignal) {
      const parsed = parseHeartbeatRequest(body)
      if (!isUuid(hostId) || !parsed.ok) throw new ControlFailure('bad-request')
      return request(
        'POST',
        CONTROL_ROUTES.hostHeartbeat,
        { hostId },
        key,
        JSON.stringify(parsed.value),
        parseHeartbeatResponse,
        false,
        signal,
      )
    },
    revoke(hostId: string, key: KeyObject) {
      if (!isUuid(hostId)) throw new ControlFailure('bad-request')
      return request(
        'POST',
        CONTROL_ROUTES.hostRevoke,
        { hostId },
        key,
        '{}',
        () => ({ ok: true, value: undefined }),
        true,
      )
    },
  }
}

function parseEmpty<T>(parse: (value: unknown) => Parsed<T>): T {
  const parsed = parse(undefined)
  if (!parsed.ok) throw new ControlFailure('internal')
  return parsed.value
}
export type ControlClient = ReturnType<typeof createControlClient>
