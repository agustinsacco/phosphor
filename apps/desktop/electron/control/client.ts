import { createHash, randomBytes } from 'node:crypto'
import {
  CONTROL_ROUTES,
  CONTROL_TRACE_HEADERS,
  isControlClient,
  DEFAULT_CONTROL_URL,
  isUuid,
  machineRoute,
  parseMachineRenameRequest,
  parseControlError,
  parseEnrollmentApproveRequest,
  parseEnrollmentApproveResponse,
  parseEnrollmentLookupRequest,
  parseEnrollmentLookupResponse,
  parseMachinesResponse,
  parseMeResponse,
  type MeResponse,
  type Parsed,
} from '@shared/control-api'
import { machineObservations, type TraceLog } from './observations'
import type { ControlResult, DesktopControlErrorCode } from '@shared/ipc'

export function controlUrl(packaged: boolean, env: NodeJS.ProcessEnv): string {
  const raw = packaged ? DEFAULT_CONTROL_URL : (env.PHOSPHOR_CONTROL_URL ?? DEFAULT_CONTROL_URL)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Invalid control server address.')
  }
  const local =
    url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !local) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid control server address.')
  return url.origin
}

export const controlFailure = (code: DesktopControlErrorCode): ControlResult<never> => ({
  ok: false,
  error: { code, message: 'The control request could not complete.' },
})

const empty = (body: unknown): Parsed<Record<never, never>> =>
  body === null ? { ok: true, value: {} } : { ok: false, reason: 'body' }

/** Main-only transport. Peer error messages are never echoed: they may contain secrets. */
export function createControlClient(ports: {
  baseUrl: () => string
  accessToken: () => Promise<string | null>
  generation: () => number
  fetch?: typeof fetch
  version?: () => string
  log?: TraceLog
  now?: () => number
}) {
  // Keyed by account generation and a digest of the token, so a refreshed
  // token re-asks /me (a suspension can be lifted) without keeping the token.
  let me: {
    generation: number
    tokenId: string
    promise: Promise<ControlResult<MeResponse>>
  } | null = null
  const fetchImpl = ports.fetch ?? fetch
  const log = ports.log ?? (() => {})
  const now = ports.now ?? Date.now
  const observations = machineObservations(log)
  let enrollmentTrace: { trace: string; expiresAt: number } | undefined
  let observedGeneration = ports.generation()
  const clearObservations = () => {
    observations.clear()
    enrollmentTrace = undefined
  }
  const newTrace = () => randomBytes(8).toString('hex')
  async function transport<T extends object>(
    token: string,
    path: string,
    method: string,
    parse: (body: unknown) => Parsed<T>,
    body: unknown,
    trace: string,
    info: { status: number; requestId: string | null; networkError: string | null },
  ): Promise<ControlResult<T>> {
    try {
      const response = await fetchImpl(new URL(path, ports.baseUrl()), {
        method,
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${token}`,
          [CONTROL_TRACE_HEADERS.client]: isControlClient(`desktop/${ports.version?.() ?? '0.0.0'}`)
            ? `desktop/${ports.version?.() ?? '0.0.0'}`
            : 'desktop/0.0.0',
          [CONTROL_TRACE_HEADERS.trace]: trace,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      info.status = response.status
      const id = response.headers.get('x-request-id')
      info.requestId = id && /^[0-9a-f]{32}$/.test(id) ? id : null
      if (response.status === 401) {
        clearObservations()
        me = null
        await response.body?.cancel().catch(() => undefined)
        return controlFailure('signed-out')
      }
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      if (reader) {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 64 * 1024) {
            await reader.cancel().catch(() => undefined)
            return controlFailure('internal')
          }
          chunks.push(chunk.value)
        }
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      let value: unknown
      try {
        value = raw === '' ? null : JSON.parse(raw)
      } catch {
        return controlFailure('internal')
      }
      if (!response.ok) {
        const error = parseControlError(value)
        return controlFailure(error?.error.code ?? 'internal')
      }
      if (method === 'DELETE' && (response.status !== 204 || size !== 0))
        return controlFailure('internal')
      if (method !== 'DELETE' && response.status !== 200) return controlFailure('internal')
      const parsed = parse(value)
      return parsed.ok ? { ok: true, ...parsed.value } : controlFailure('internal')
    } catch (error) {
      info.networkError =
        error instanceof TypeError
          ? 'TypeError'
          : error instanceof DOMException &&
              (error.name === 'AbortError' || error.name === 'TimeoutError')
            ? error.name
            : 'Error'
      return controlFailure('offline')
    }
  }
  async function request<T extends object>(
    token: string,
    path: string,
    method: string,
    parse: (body: unknown) => Parsed<T>,
    body: unknown,
    trace: string,
  ): Promise<ControlResult<T>> {
    const start = now()
    const info: { status: number; requestId: string | null; networkError: string | null } = {
      status: 0,
      requestId: null,
      networkError: null,
    }
    const result = await transport(token, path, method, parse, body, trace, info)
    log('control', 'call', {
      method,
      route: path.startsWith(CONTROL_ROUTES.machines + '/')
        ? CONTROL_ROUTES.machines + '/:id'
        : path,
      status: info.status,
      requestId: info.requestId,
      ms: Math.max(0, now() - start),
      trace,
      code: result.ok
        ? null
        : result.error.code === 'offline'
          ? info.networkError
          : result.error.code === 'signed-out'
            ? 'unauthenticated'
            : result.error.code,
    })
    return result
  }
  async function call<T extends object>(
    path: string,
    method: string,
    parse: (value: unknown) => Parsed<T>,
    body?: unknown,
    trace = newTrace(),
  ): Promise<ControlResult<T>> {
    try {
      const generation = ports.generation()
      if (observedGeneration !== generation) {
        clearObservations()
        observedGeneration = generation
      }
      if (me?.generation !== generation) me = null
      const token = await ports.accessToken()
      if (!token || ports.generation() !== generation) {
        clearObservations()
        me = null
        return controlFailure('signed-out')
      }
      const tokenId = createHash('sha256').update(token).digest('hex')
      if (me?.tokenId !== tokenId) me = null
      if (!me) {
        const cached = {
          generation,
          tokenId,
          promise: request(token, CONTROL_ROUTES.me, 'GET', parseMeResponse, undefined, trace),
        }
        me = cached
        void cached.promise.then((result) => {
          if (!result.ok && me === cached) me = null
        })
      }
      const account = await me.promise
      if (ports.generation() !== generation) return controlFailure('signed-out')
      if (!account.ok) return account
      if (!account.enabled) return controlFailure('forbidden')
      const result = await request(token, path, method, parse, body, trace)
      return ports.generation() === generation ? result : controlFailure('signed-out')
    } catch {
      return controlFailure('offline')
    }
  }
  return {
    clearObservations,
    async machines() {
      const trace = newTrace()
      const result = await call(
        CONTROL_ROUTES.machines,
        'GET',
        parseMachinesResponse,
        undefined,
        trace,
      )
      if (result.ok) observations.observe(result, now(), trace)
      return result
    },
    async lookupEnrollment(code: unknown) {
      const trace = newTrace()
      const parsed = parseEnrollmentLookupRequest({ userCode: code })
      const result = parsed.ok
        ? await call(
            CONTROL_ROUTES.enrollmentLookup,
            'POST',
            parseEnrollmentLookupResponse,
            parsed.value,
            trace,
          )
        : controlFailure('bad-request')
      enrollmentTrace = result.ok
        ? { trace, expiresAt: Math.min(Date.parse(result.expiresAt), now() + 15 * 60_000) }
        : undefined
      log('control', 'enrollment.lookup', {
        trace,
        result: result.ok ? 'found' : result.error.code,
        ...(result.ok ? { hostname: result.hostname, keyFingerprint: result.keyFingerprint } : {}),
      })
      return result
    },
    async approveEnrollment(code: unknown, label: unknown) {
      if (observedGeneration !== ports.generation()) {
        clearObservations()
        observedGeneration = ports.generation()
      }
      const trace =
        enrollmentTrace && enrollmentTrace.expiresAt > now() ? enrollmentTrace.trace : newTrace()
      enrollmentTrace = undefined
      const parsed = parseEnrollmentApproveRequest({ userCode: code, label })
      const result = parsed.ok
        ? await call(
            CONTROL_ROUTES.enrollmentApprove,
            'POST',
            parseEnrollmentApproveResponse,
            parsed.value,
            trace,
          )
        : controlFailure('bad-request')
      log('control', 'enrollment.approved', {
        trace,
        result: result.ok ? 'approved' : result.error.code,
        ...(result.ok
          ? {
              hostId: result.machine.id,
              hostname: result.machine.hostname,
              keyFingerprint: result.machine.keyFingerprint,
            }
          : {}),
      })
      return result
    },
    renameMachine(id: unknown, label: unknown) {
      const parsed = parseMachineRenameRequest({ label })
      return isUuid(id) && parsed.ok
        ? call(machineRoute(id), 'PATCH', parseEnrollmentApproveResponse, parsed.value)
        : Promise.resolve(controlFailure('bad-request'))
    },
    removeMachine(id: unknown) {
      return isUuid(id)
        ? call(machineRoute(id), 'DELETE', empty)
        : Promise.resolve(controlFailure('bad-request'))
    },
  }
}
