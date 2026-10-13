import {
  CONTROL_TRACE_HEADERS,
  isControlClient,
  isControlTrace,
  CONTROL_ERROR_STATUS,
  type ControlErrorCode,
} from '@phosphor/shared/control-api'
import type { MiddlewareHandler } from 'hono'
import { isIP } from 'node:net'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import type { Config } from './config'
import type { User } from './auth/user'

export class ControlFailure extends Error {
  constructor(
    readonly code: ControlErrorCode,
    readonly status: (typeof CONTROL_ERROR_STATUS)[ControlErrorCode] | 405 = CONTROL_ERROR_STATUS[
      code
    ],
  ) {
    super(code)
  }
}
export type Env = {
  Bindings: {
    incoming?: {
      url?: string
      headers: IncomingHttpHeaders
      socket?: { remoteAddress?: string }
    }
  }
  Variables: {
    rawBody: Uint8Array
    actor: string
    requestId: string
    user: User
    ip: string
    error: ControlErrorCode
  }
}
export interface RequestLog {
  ts: string
  level: 'info'
  requestId: string
  method: string
  route: string
  status: number
  ms: number
  actor: string
  client: string
  trace: string | null
  error: ControlErrorCode | null
  pathClass?: 'page' | 'asset'
}

export async function readBytes(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array()
  const reader = stream.getReader()
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (signal?.aborted) throw new ControlFailure('unavailable')
      if (done) break
      size += value.byteLength
      if (size > max) {
        void reader.cancel().catch(() => {})
        throw new ControlFailure('payload-too-large')
      }
      if (value.byteLength) chunks.push(value)
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export function requestMiddleware(
  clock: () => number,
  random: (size: number) => Uint8Array,
  log: (entry: RequestLog) => void,
): MiddlewareHandler<Env> {
  return async (c, next) => {
    const start = clock()
    c.set('requestId', Buffer.from(random(16)).toString('hex'))
    c.set('actor', 'anon')
    await next()
    c.header('x-request-id', c.get('requestId'))
    if (c.req.path === '/healthz' || c.req.header('user-agent')?.startsWith('kube-probe/')) return
    const client = c.req.header(CONTROL_TRACE_HEADERS.client)
    const trace = c.req.header(CONTROL_TRACE_HEADERS.trace)
    log({
      ts: new Date(start).toISOString(),
      level: 'info',
      requestId: c.get('requestId'),
      method: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'].includes(c.req.method)
        ? c.req.method
        : 'OTHER',
      route: c.req.path.startsWith('/api/')
        ? c.req.routePath === '/*'
          ? 'unmatched'
          : c.req.routePath
        : 'site',
      status: c.res.status,
      ms: Math.max(0, clock() - start),
      actor: c.get('actor'),
      client: isControlClient(client) && isControlTrace(trace) ? client : 'invalid',
      trace: isControlTrace(trace) ? trace : null,
      error: c.res.status >= 400 ? (c.get('error') ?? 'not-found') : null,
      ...(!c.req.path.startsWith('/api/')
        ? {
            pathClass:
              c.req.path.startsWith('/_astro/') ||
              c.req.path.startsWith('/fonts/') ||
              /\.(?!html$)[a-z0-9]{1,10}$/i.test(c.req.path)
                ? ('asset' as const)
                : ('page' as const),
          }
        : {}),
    })
  }
}

export const apiHeaders: MiddlewareHandler<Env> = async (c, next) => {
  if (!c.req.path.startsWith('/api/') && !rawTarget(c.req.raw, c.env).startsWith('/api/')) {
    await next()
    return
  }
  c.header('Cache-Control', 'no-store')
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  await next()
}

/** servicelb SNAT hides the peer, so only the authenticated edge may supply an IP. */
export function clientIp(request: Request, socketAddress: string, config: Config): string {
  const forwarded = request.headers.get('cf-connecting-ip')
  const edge = request.headers.get('x-phosphor-edge')
  if (config.trustProxy !== 'cloudflare' || !forwarded || !isIP(forwarded) || !edge)
    return socketAddress
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(edge), digest(config.edgeSecret)) ? forwarded : socketAddress
}

/** The Node adapter hides GET/HEAD bodies, so check framing before reading Fetch bytes. */
export function refuseBody(request: Request, bindings: Env['Bindings'] | undefined): void {
  if (!['GET', 'HEAD', 'DELETE'].includes(request.method)) return
  const headers = bindings?.incoming?.headers
  const transferEncoding = headers
    ? headers['transfer-encoding']
    : request.headers.get('transfer-encoding')
  const contentLength = headers ? headers['content-length'] : request.headers.get('content-length')
  if (transferEncoding != null || (contentLength != null && contentLength !== '0'))
    throw new ControlFailure('bad-request')
}

export function rawTarget(request: Request, bindings: Env['Bindings'] | undefined): string {
  const url = new URL(request.url)
  return bindings?.incoming?.url ?? url.pathname + url.search
}
/** Check before WHATWG normalization can hide dot segments from the router. */
export function unsafeRawTarget(target: string): boolean {
  const path = target.split('?')[0] ?? ''
  return (
    !path.startsWith('/') ||
    path.includes('//') ||
    path.includes('\\') ||
    path.includes('\0') ||
    /%(?:2f|5c|00)/i.test(path) ||
    path
      .replace(/%2e/gi, '.')
      .split('/')
      .some((part) => part === '.' || part === '..')
  )
}
