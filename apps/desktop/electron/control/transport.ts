import {
  CONTROL_ROUTES,
  CONTROL_TRACE_HEADERS,
  isControlClient,
  parseControlError,
  type Parsed,
} from '@shared/control-api'
import type { ControlResult, DesktopControlErrorCode } from '@shared/ipc'
import type { TraceLog } from './observations'

export interface ControlTransportPorts {
  baseUrl: () => string
  fetch?: typeof fetch
  version?: () => string
  log: TraceLog
  now: () => number
}

export const controlFailure = (code: DesktopControlErrorCode): ControlResult<never> => ({
  ok: false,
  error: { code, message: 'The control request could not complete.' },
})

type ResponseInfo = { status: number; requestId: string | null; networkError: string | null }

async function readResponse(
  response: Response,
): Promise<{ ok: true; value: unknown; size: number } | { ok: false }> {
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
        return { ok: false }
      }
      chunks.push(chunk.value)
    }
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  let value: unknown
  try {
    value = raw === '' ? null : JSON.parse(raw)
  } catch {
    return { ok: false }
  }
  return { ok: true, value, size }
}

async function transport<T extends object>(
  ports: ControlTransportPorts,
  onUnauthorized: () => void,
  token: string,
  path: string,
  method: string,
  parse: (body: unknown) => Parsed<T>,
  body: unknown,
  trace: string,
  info: ResponseInfo,
): Promise<ControlResult<T>> {
  try {
    const response = await (ports.fetch ?? fetch)(new URL(path, ports.baseUrl()), {
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
      onUnauthorized()
      await response.body?.cancel().catch(() => undefined)
      return controlFailure('signed-out')
    }
    const content = await readResponse(response)
    if (!content.ok) return controlFailure('internal')
    const { value, size } = content
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

/** Bounded main-only HTTP. Peer text and exception messages never leave this boundary. */
export function createControlTransport(ports: ControlTransportPorts, onUnauthorized: () => void) {
  const transportPorts = { ...ports, fetch: ports.fetch ?? fetch }
  return async function request<T extends object>(
    token: string,
    path: string,
    method: string,
    parse: (body: unknown) => Parsed<T>,
    body: unknown,
    trace: string,
  ): Promise<ControlResult<T>> {
    const start = ports.now()
    const info: ResponseInfo = {
      status: 0,
      requestId: null,
      networkError: null,
    }
    const result = await transport(
      transportPorts,
      onUnauthorized,
      token,
      path,
      method,
      parse,
      body,
      trace,
      info,
    )
    ports.log('control', 'call', {
      method,
      route: path.startsWith(CONTROL_ROUTES.machines + '/')
        ? CONTROL_ROUTES.machines + '/:id'
        : path,
      status: info.status,
      requestId: info.requestId,
      ms: Math.max(0, ports.now() - start),
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
}

export type ControlRequest = ReturnType<typeof createControlTransport>
