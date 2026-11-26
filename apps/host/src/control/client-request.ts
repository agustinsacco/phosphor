import { randomBytes, type KeyObject } from 'node:crypto'
import { CONTROL_TRACE_HEADERS, type Parsed } from '@phosphor/shared/control-api'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import { signRequest, type SigningIdentity } from './signer'
import { HOST_VERSION } from '../version'
import { ControlFailure, ControlRequestFailure, parseResponse } from './client-response'

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
  readonly deadlineAt?: number
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

type Transport = NonNullable<ControlRequestFailure['transport']>

function transportCause(error: unknown): Transport {
  if (error instanceof TypeError) return 'TypeError'
  if (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
    return error.name
  return 'Error'
}

function retryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now
  return Number.isFinite(ms) ? Math.max(1, ms) : undefined
}

function classify(error: unknown, status: number, timedOut: boolean, after?: number) {
  if (!(error instanceof ControlFailure)) {
    const cause = transportCause(error)
    const stage = timedOut || cause === 'TimeoutError' ? 'control-timeout' : 'control-unreachable'
    return new ControlRequestFailure('offline', stage, cause)
  }
  if (status === 429)
    return new ControlRequestFailure('too-many-requests', 'rate-limited', 'http', after)
  if (status >= 500) return new ControlRequestFailure(error.code, 'control-unreachable', 'http')
  if (
    (status >= 200 && status < 300) ||
    error.code === 'internal' ||
    error.code === 'payload-too-large'
  )
    return new ControlRequestFailure(error.code, 'bad-response', 'http')
  return error
}

export async function executeRequest<T>(state: ClientState, args: RequestArgs<T>): Promise<T> {
  const { trace, ports } = state
  const { method, path, parse, empty = false, signal = ports.signal, seq } = args
  const start = (ports.now ?? Date.now)()
  let status = 0
  let after: number | undefined
  let requestId: string | null = null
  let code: string | null = null
  const controller = new AbortController()
  const abort = () => controller.abort()
  const ms = Math.min(10_000, Math.max(0, (args.deadlineAt ?? Infinity) - start))
  const timer = setTimeout(abort, ms)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted || ms === 0) abort()
  try {
    // The reach budget must not start another request after cancellation.
    // Existing control callers delegate cancellation to their transport.
    if (args.deadlineAt !== undefined) controller.signal.throwIfAborted()
    const response = await sendRequest(state, args, controller.signal)
    status = response.status
    if (status === 429) after = retryAfter(response.headers.get('retry-after'), start)
    const id = response.headers.get('x-request-id')
    requestId = id && /^[0-9a-f]{32}$/.test(id) ? id : null
    const value = await parseResponse(response, parse, empty)
    if (args.deadlineAt !== undefined) controller.signal.throwIfAborted()
    return value
  } catch (error) {
    code = error instanceof ControlFailure ? error.code : transportCause(error)
    throw classify(error, status, controller.signal.aborted, after)
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
