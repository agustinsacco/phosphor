import { createHash } from 'node:crypto'
import {
  CONTROL_ROUTES,
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
}) {
  // Keyed by account generation and a digest of the token, so a refreshed
  // token re-asks /me (a suspension can be lifted) without keeping the token.
  let me: {
    generation: number
    tokenId: string
    promise: Promise<ControlResult<MeResponse>>
  } | null = null
  const fetchImpl = ports.fetch ?? fetch
  async function request<T extends object>(
    token: string,
    path: string,
    method: string,
    parse: (body: unknown) => Parsed<T>,
    body?: unknown,
  ): Promise<ControlResult<T>> {
    try {
      const response = await fetchImpl(new URL(path, ports.baseUrl()), {
        method,
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (response.status === 401) {
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
    } catch {
      return controlFailure('offline')
    }
  }
  async function call<T extends object>(
    path: string,
    method: string,
    parse: (value: unknown) => Parsed<T>,
    body?: unknown,
  ): Promise<ControlResult<T>> {
    try {
      const generation = ports.generation()
      if (me?.generation !== generation) me = null
      const token = await ports.accessToken()
      if (!token || ports.generation() !== generation) {
        me = null
        return controlFailure('signed-out')
      }
      const tokenId = createHash('sha256').update(token).digest('hex')
      if (me?.tokenId !== tokenId) me = null
      if (!me) {
        const cached = {
          generation,
          tokenId,
          promise: request(token, CONTROL_ROUTES.me, 'GET', parseMeResponse),
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
      const result = await request(token, path, method, parse, body)
      return ports.generation() === generation ? result : controlFailure('signed-out')
    } catch {
      return controlFailure('offline')
    }
  }
  return {
    machines: () => call(CONTROL_ROUTES.machines, 'GET', parseMachinesResponse),
    lookupEnrollment(code: unknown) {
      const parsed = parseEnrollmentLookupRequest({ userCode: code })
      return parsed.ok
        ? call(CONTROL_ROUTES.enrollmentLookup, 'POST', parseEnrollmentLookupResponse, parsed.value)
        : Promise.resolve(controlFailure('bad-request'))
    },
    approveEnrollment(code: unknown, label: unknown) {
      const parsed = parseEnrollmentApproveRequest({ userCode: code, label })
      return parsed.ok
        ? call(
            CONTROL_ROUTES.enrollmentApprove,
            'POST',
            parseEnrollmentApproveResponse,
            parsed.value,
          )
        : Promise.resolve(controlFailure('bad-request'))
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
