import { CONTROL_TRACE_HEADERS, isControlTrace } from '@phosphor/shared/control-api'
import type { Socket } from 'node:net'
import { randomBytes, type KeyObject } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import {
  HOST_API_PORT,
  HOST_API_ROUTES,
  HOST_LIMITS,
  HOST_PROTOCOL_VERSION,
} from '@phosphor/shared/host-protocol'
import type { HostHello } from '@phosphor/shared/remote-host'
import type { Authority } from './authority'
import { createKeyset, type Keyset } from './keyset'
import { createConnection, hostProof, type ApiLog, type ConnectionPorts } from './connection'
import { createGrantAuth } from './grant-auth'
import type { LaneService } from '../lanes/service'
import { createLaneAdapter } from './lanes'
import { admitsBrowserOrigin, resolveWebOrigin } from './browser-origin'
import { createWsUpgrade, rejectTransport } from './ws-upgrade'
import { createAdapterChain } from './adapter'
import { createMachineAdapter } from './machine-adapter'
import { createOwnerAdapter } from '../owner/adapter'
import { createOpsAdapter, type OpsAdapterPorts } from '../ops/adapter'

export const API_LIMITS = {
  connections: 64,
  rawSockets: 80,
  headersTimeout: 10_000,
  requestTimeout: 10_000,
  keepAliveTimeout: 5000,
  connectionsCheckingInterval: 1000,
  helloPerSecond: 10,
  retryMs: 60_000,
  rejecting: 16,
  closeGraceMs: 2000,
}

/** Do not reflect header values, including Tailscale identity headers. */
export function requestStatus(
  request: IncomingMessage,
  port: number,
  webOrigin: string | null = null,
) {
  const host = request.headers.host
  if (
    !host ||
    !(
      host === `127.0.0.1:${port}` ||
      host === `localhost:${port}` ||
      /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net(?::[1-9][0-9]{0,4})?$/i.test(host)
    )
  )
    return 421
  if (host.includes(':') && Number(host.slice(host.lastIndexOf(':') + 1)) > 65535) return 421
  if (!admitsBrowserOrigin(request, webOrigin)) return 403
  if (request.method !== 'GET') return 405
  return 0
}

/** A client holds at most `connectionsPerClient` sockets at once. */
function admits(
  connections: Iterable<ReturnType<typeof createConnection>>,
  clientId: string,
  limits: ConnectionPorts['limits'],
) {
  const held = [...connections].filter((c) => c.clientId() === clientId).length
  return held < (limits?.connectionsPerClient ?? HOST_LIMITS.connectionsPerClient)
}

/** A TCP connection's authenticator: control-signed grants for this Host. */
function grantAuth(options: ApiOptions, keyset: Keyset, hello: HostHello) {
  return createGrantAuth({
    authority: options.authority,
    keyset,
    origin: options.origin,
    hello,
    key: options.key,
    webPushKey: options.lanes?.webPushKey,
  })
}

/**
 * Owner methods, then the machine guard, then `ops.run`; the lane adapter comes
 * last. The guard answers only machine grants, so it sits ahead of `ops.run`
 * to refuse surface-only ops before the dispatcher sees them.
 */
export function hostLinks(ops?: OpsAdapterPorts) {
  return [createOwnerAdapter(), createMachineAdapter(), createOpsAdapter(ops)]
}

function connectionAdapters(options: ApiOptions) {
  const adapter = options.lanes ? createLaneAdapter(options.lanes, { log: options.log }) : undefined
  return { adapter, handler: createAdapterChain(hostLinks(options.ops), adapter?.handler) }
}

interface ApiOptions {
  authority: Authority
  origin: string
  webOrigin?: string | null
  hostId: string
  hostVersion: string
  runtimeEpoch?: string
  lanes?: LaneService
  /** Unbound until the Host serves ops; `ops.run` then reaches the lane adapter as before. */
  ops?: OpsAdapterPorts
  key: KeyObject
  port?: number
  fetch?: typeof fetch
  log?: ApiLog
  ports?: Pick<ConnectionPorts, 'onReady' | 'onClose'>
  connectionLimits?: ConnectionPorts['limits']
  limits?: Partial<Record<keyof typeof API_LIMITS, number>>
}

export function startApi(options: ApiOptions) {
  const webOrigin = resolveWebOrigin(options.origin, options.webOrigin)
  const limits = { ...API_LIMITS, ...options.limits }
  for (const name of [
    'connections',
    'rejecting',
    'closeGraceMs',
    'rawSockets',
    'headersTimeout',
    'requestTimeout',
    'keepAliveTimeout',
    'connectionsCheckingInterval',
    'helloPerSecond',
    'retryMs',
  ] as const)
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > API_LIMITS[name])
      throw new Error('Invalid API limit')
  const port = options.port ?? HOST_API_PORT
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid API port')
  const runtimeEpoch =
    options.runtimeEpoch ?? options.lanes?.epoch ?? randomBytes(8).toString('hex')
  if (
    !/^[0-9a-f]{16}$/.test(runtimeEpoch) ||
    (options.lanes && options.lanes.epoch !== runtimeEpoch)
  )
    throw new Error('Invalid runtime epoch')
  const { adapter, handler } = connectionAdapters(options)
  const hello: HostHello = {
    hostId: options.hostId,
    hostVersion: options.hostVersion,
    protocolVersion: HOST_PROTOCOL_VERSION,
    runtimeEpoch,
    capabilities: [...(options.lanes?.capabilities ?? [])],
  }
  const keyset = createKeyset(options.origin, options.fetch)
  const raw = new Set<Socket>()
  let stopped = false
  let binding = false
  let listening = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let second = -1
  let requests = 0
  const server = createServer(
    {
      headersTimeout: limits.headersTimeout,
      requestTimeout: limits.requestTimeout,
      keepAliveTimeout: limits.keepAliveTimeout,
      connectionsCheckingInterval: limits.connectionsCheckingInterval,
    },
    (request, response) => {
      const status = requestStatus(request, port, webOrigin)
      if (status) {
        response.writeHead(status).end()
        return
      }
      let url: URL
      try {
        url = new URL(request.url ?? '/', 'http://localhost')
      } catch {
        response.writeHead(400).end()
        return
      }
      if (url.pathname !== HOST_API_ROUTES.hello) {
        response.writeHead(url.pathname.startsWith(HOST_API_ROUTES.hello) ? 400 : 404).end()
        return
      }
      const challenge = url.searchParams.get('challenge')
      if (
        !challenge ||
        !/^[0-9a-f]{64}$/.test(challenge) ||
        [...url.searchParams.keys()].length !== 1
      ) {
        response.writeHead(400).end()
        return
      }
      const current = Math.floor(Date.now() / 1000)
      if (second !== current) {
        second = current
        requests = 0
      }
      if (++requests > limits.helloPerSecond) {
        response.writeHead(429).end()
        return
      }
      const trace = request.headers[CONTROL_TRACE_HEADERS.trace]
      options.log?.('api.hello', isControlTrace(trace) ? { trace } : {})
      response
        .writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          vary: 'Origin',
          ...(request.headers.origin && webOrigin
            ? { 'access-control-allow-origin': webOrigin }
            : {}),
        })
        .end(JSON.stringify({ hello, proof: hostProof(hello, challenge, options.key) }))
    },
  )
  server.on('connection', (socket) => {
    socket.on('error', () => {})
    if (raw.size >= limits.rawSockets) {
      rejectTransport(socket)
      return
    }
    raw.add(socket)
    socket.on('close', () => raw.delete(socket))
  })
  const upgrades = createWsUpgrade({
    status: (request) =>
      requestStatus(request, port, webOrigin) || (request.url !== HOST_API_ROUTES.stream ? 404 : 0),
    accepting: () => !stopped && !!options.authority.snapshot(),
    limits,
    sendQueueBytes: options.connectionLimits?.sendQueueBytes ?? HOST_LIMITS.sendQueueBytes,
    connect: (socket, ping) =>
      createConnection({
        ...options.ports,
        handler,
        socket,
        ping,
        limits: options.connectionLimits,
        authenticate: grantAuth(options, keyset, hello),
        log: options.log,
        admit: (clientId): boolean =>
          admits(upgrades.connections(), clientId, options.connectionLimits),
      }),
  })
  server.on('upgrade', upgrades.upgrade)
  server.on('error', () => {
    binding = false
    options.log?.('api.unavailable', { port })
    if (!stopped) {
      retry = setTimeout(() => {
        retry = undefined
        listen()
      }, limits.retryMs)
      retry.unref()
    }
  })
  function listen() {
    if (stopped || listening || binding || retry !== undefined || !options.authority.snapshot())
      return
    binding = true
    server.listen(port, '127.0.0.1', () => {
      binding = false
      listening = true
      options.log?.('api.listening', { port })
      if (stopped) server.close()
    })
  }
  const unsubscribe = options.authority.onChange(listen)
  listen()
  return {
    deliver: adapter?.deliver ?? (() => {}),
    isConnected: adapter?.isConnected ?? (() => false),
    async stop() {
      stopped = true
      unsubscribe()
      clearTimeout(retry)
      keyset.stop()
      await upgrades.close(1001)
      for (const socket of raw) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
