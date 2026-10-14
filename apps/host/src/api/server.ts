import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { randomBytes, type KeyObject } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import {
  HOST_API_PORT,
  HOST_API_ROUTES,
  HOST_LIMITS,
  HOST_PROTOCOL_VERSION,
  type FrameSocket,
} from '@phosphor/shared/host-protocol'
import type { HostHello } from '@phosphor/shared/remote-host'
import type { Authority } from './authority'
import { createKeyset } from './keyset'
import { createConnection, hostProof, type ApiLog, type ConnectionPorts } from './connection'
import type { LaneService } from '../lanes/service'
import { createLaneAdapter } from './lanes'

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
export function requestStatus(request: IncomingMessage, port: number) {
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
  if (request.headers.origin !== undefined) return 403
  if (request.method !== 'GET') return 405
  return 0
}

export function startApi(options: {
  authority: Authority
  origin: string
  hostId: string
  hostVersion: string
  runtimeEpoch?: string
  lanes?: LaneService
  key: KeyObject
  port?: number
  fetch?: typeof fetch
  log?: ApiLog
  ports?: Pick<ConnectionPorts, 'onReady' | 'onClose'>
  connectionLimits?: ConnectionPorts['limits']
  limits?: Partial<Record<keyof typeof API_LIMITS, number>>
}) {
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
  let rejecting = 0
  const closing = new WeakSet<WebSocket>()
  function closeSocket(ws: WebSocket, code: number) {
    if (closing.has(ws)) return
    closing.add(ws)
    ws.close(code)
    terminateAfterGrace(ws)
  }
  function terminateAfterGrace(ws: WebSocket) {
    const timer = setTimeout(() => ws.terminate(), limits.closeGraceMs)
    timer.unref()
    ws.once('close', () => clearTimeout(timer))
  }
  const port = options.port ?? HOST_API_PORT
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid API port')
  const runtimeEpoch =
    options.runtimeEpoch ?? options.lanes?.epoch ?? randomBytes(8).toString('hex')
  if (
    !/^[0-9a-f]{16}$/.test(runtimeEpoch) ||
    (options.lanes && options.lanes.epoch !== runtimeEpoch)
  )
    throw new Error('Invalid runtime epoch')
  const adapter = options.lanes ? createLaneAdapter(options.lanes, { log: options.log }) : undefined
  const hello: HostHello = {
    hostId: options.hostId,
    hostVersion: options.hostVersion,
    protocolVersion: HOST_PROTOCOL_VERSION,
    runtimeEpoch,
    capabilities: [...(options.lanes?.capabilities ?? [])],
  }
  const keyset = createKeyset(options.origin, options.fetch)
  const raw = new Set<Socket>()
  function reject(transport: Duplex, status = 429) {
    transport.write(
      `HTTP/1.1 ${status} ${status === 429 ? 'Too Many Requests' : 'Rejected'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      () => transport.destroy(),
    )
  }
  const connections = new Map<WebSocket, ReturnType<typeof createConnection>>()
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
      const status = requestStatus(request, port)
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
      response
        .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ hello, proof: hostProof(hello, challenge, options.key) }))
    },
  )
  server.on('connection', (socket) => {
    socket.on('error', () => {})
    if (raw.size >= limits.rawSockets) {
      reject(socket)
      return
    }
    raw.add(socket)
    socket.on('close', () => raw.delete(socket))
  })
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: HOST_LIMITS.inboundFrameBytes,
    perMessageDeflate: false,
    autoPong: false,
  })
  wss.on('error', () => {})
  server.on('upgrade', (request, transport, head) => {
    const status =
      requestStatus(request, port) || (request.url !== HOST_API_ROUTES.stream ? 404 : 0)
    if (status || stopped || !options.authority.snapshot()) {
      reject(transport, status || 503)
      return
    }
    if (wss.clients.size >= limits.connections && rejecting >= limits.rejecting) {
      reject(transport)
      return
    }
    wss.handleUpgrade(request, transport, head, (ws) => {
      ws.on('error', () => {
        if (!closing.has(ws)) {
          closing.add(ws)
          terminateAfterGrace(ws)
        }
      })
      if (wss.clients.size > limits.connections) {
        rejecting++
        ws.once('close', () => {
          rejecting--
        })
        closeSocket(ws, 4429)
        return
      }
      const socket: FrameSocket = {
        send: (text) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(text)
        },
        close: (code) => closeSocket(ws, code),
        onMessage: (cb) =>
          ws.on('message', (data, binary) => {
            if (binary) {
              connection.rejectFrame()
              return
            }
            cb(data.toString())
          }),
        onClose: (cb) => ws.on('close', (code) => cb(code, '')),
        isOpen: () => ws.readyState === WebSocket.OPEN,
        bufferedBytes: () => ws.bufferedAmount,
      }
      function controlFrame(data?: Buffer) {
        if (ws.readyState !== WebSocket.OPEN) return
        if (
          socket.bufferedBytes() + (data?.length ?? 0) >
          (options.connectionLimits?.sendQueueBytes ?? HOST_LIMITS.sendQueueBytes)
        ) {
          closeSocket(ws, 4429)
          return
        }
        if (data) ws.pong(data)
        else ws.ping()
      }
      ws.on('ping', (data) => controlFrame(data))
      const connection = createConnection({
        ...options.ports,
        handler: adapter?.handler,
        socket,
        ping: () => controlFrame(),
        limits: options.connectionLimits,
        authority: options.authority,
        keyset,
        origin: options.origin,
        hello,
        key: options.key,
        log: options.log,
        admit: (clientId) =>
          [...connections.values()].filter((c) => c.clientId() === clientId).length <
          (options.connectionLimits?.connectionsPerClient ?? HOST_LIMITS.connectionsPerClient),
      })
      connections.set(ws, connection)
      ws.on('close', () => {
        connections.delete(ws)
      })
    })
  })
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
      for (const connection of connections.values()) connection.close(1001)
      for (const ws of wss.clients) closeSocket(ws, 1001)
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      for (const socket of raw) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
