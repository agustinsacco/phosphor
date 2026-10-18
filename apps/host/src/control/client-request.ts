import { randomBytes, type KeyObject } from 'node:crypto'
import { CONTROL_TRACE_HEADERS, type Parsed } from '@phosphor/shared/control-api'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import { signRequest, type SigningIdentity } from './signer'
import { HOST_VERSION } from '../version'
import { ControlFailure, parseResponse } from './client-response'

export interface ClientPorts {
  fetch?: typeof fetch
  now?: () => number
  random?: (size: number) => Uint8Array
  signal?: AbortSignal
  trace?: string
  log?: RuntimeLog
}

export interface ClientState {
  readonly url: string
  readonly trace: string
  readonly ports: ClientPorts
}

export interface RequestArgs<T> {
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly identity: SigningIdentity
  readonly key: KeyObject
  readonly body: string
  readonly parse: (value: unknown) => Parsed<T>
  readonly empty?: boolean
  readonly signal?: AbortSignal
  readonly seq?: number
}

function sendRequest<T>(state: ClientState, args: RequestArgs<T>, signal: AbortSignal) {
  const { url, trace, ports } = state
  const { method, path, identity, key, body } = args
  return (ports.fetch ?? fetch)(`${url}${path}`, {
    method,
    redirect: 'error',
    signal,
    headers: {
      'content-type': 'application/json',
      [CONTROL_TRACE_HEADERS.client]: `host/${HOST_VERSION}`,
      [CONTROL_TRACE_HEADERS.trace]: trace,
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
}

function failureCode(error: unknown): string {
  return error instanceof ControlFailure
    ? error.code
    : error instanceof TypeError
      ? 'TypeError'
      : error instanceof DOMException &&
          (error.name === 'AbortError' || error.name === 'TimeoutError')
        ? error.name
        : 'Error'
}

export async function executeRequest<T>(state: ClientState, args: RequestArgs<T>): Promise<T> {
  const { trace, ports } = state
  const { method, path, parse, empty = false, signal = ports.signal, seq } = args
  const start = (ports.now ?? Date.now)()
  let status = 0
  let requestId: string | null = null
  let code: string | null = null
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, 10_000)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try {
    const response = await sendRequest(state, args, controller.signal)
    status = response.status
    const id = response.headers.get('x-request-id')
    requestId = id && /^[0-9a-f]{32}$/.test(id) ? id : null
    return await parseResponse(response, parse, empty)
  } catch (error) {
    code = failureCode(error)
    if (error instanceof ControlFailure) throw error
    throw new ControlFailure('offline')
  } finally {
    ports.log?.('control', 'call', {
      method,
      route: path,
      status,
      ms: Math.max(0, (ports.now ?? Date.now)() - start),
      requestId,
      trace,
      code,
      ...(seq === undefined ? {} : { seq }),
    })
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
