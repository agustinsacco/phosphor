import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import { dirname } from 'node:path'
import {
  HOST_API_ROUTES,
  HOST_LIMITS,
  HOST_PROTOCOL_VERSION,
  utf8Length,
} from '@phosphor/shared/host-protocol'
import { LOCAL_LIMITS, chooseLocalSocket } from '@phosphor/shared/host-local'
import type { HostCapability, HostHello } from '@phosphor/shared/remote-host'
import { errnoIs, isOwnerPrivate } from '@phosphor/session-runtime/fs-safety'
import { createAdapterChain, type FrameLinkFactory } from './adapter'
import {
  createConnection,
  hostProof,
  type ApiLog,
  type AuthenticatedHandler,
  type ConnectionPorts,
  type ReadyConnection,
} from './connection'
import {
  createLocalAuth,
  createLocalNonces,
  type LocalAuthPorts,
  type LocalNonces,
} from './local-auth'
import { API_LIMITS } from './server'
import { createWsUpgrade, rejectTransport } from './ws-upgrade'

export type LocalSocketRefusal = 'path' | 'folder' | 'occupied'

/** The socket cannot be served safely; nothing was bound. */
export class LocalSocketRefused extends Error {
  readonly reason: LocalSocketRefusal

  constructor(reason: LocalSocketRefusal, message: string) {
    super(message)
    this.name = 'LocalSocketRefused'
    this.reason = reason
  }
}

/** The first candidate that fits `sun_path`, measured in UTF-8 bytes before any bind. */
export function chooseSocketPath(candidates: readonly string[]): string {
  const path = chooseLocalSocket(candidates)
  if (!path)
    throw new LocalSocketRefused(
      'path',
      `No local socket path fits in ${LOCAL_LIMITS.socketPathBytes} bytes.`,
    )
  return path
}

/**
 * The socket's folder: created 0700 when missing (its parent must exist), and
 * then it must be a real folder owned by `uid` with no group or other bit. A
 * folder someone else made, as in a shared `/tmp`, is refused, never loosened
 * or replaced. A folder this call did not create is never chmodded.
 */
export function prepareSocketFolder(folder: string, uid: number | undefined): void {
  try {
    mkdirSync(folder, { mode: 0o700 })
    chmodSync(folder, 0o700)
  } catch (error) {
    if (!errnoIs(error, 'EEXIST'))
      throw new LocalSocketRefused('folder', `The local socket folder cannot be created.`)
  }
  const info = lstatSync(folder)
  if (info.isSymbolicLink() || !info.isDirectory() || !isOwnerPrivate(info, uid))
    throw new LocalSocketRefused(
      'folder',
      'The local socket folder must be a folder you own with mode 0700.',
    )
}

/** True unless connecting is refused: only ECONNREFUSED proves no listener holds `path`. */
function answering(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe: Socket = connect(path)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', (error) => resolve(!errnoIs(error, 'ECONNREFUSED')))
  })
}

/** Removes a stale socket file. Run holds its run lock; a live listener or any other file is refused. */
export async function clearStaleSocket(path: string): Promise<void> {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return
    throw error
  }
  if (!info.isSocket() || (await answering(path)))
    throw new LocalSocketRefused('occupied', 'Another program holds the local socket path.')
  unlinkSync(path)
}

/** What the socket serves once the machine starts: the lane service's hello, its links and the shared lane adapter. */
export interface LocalLanes {
  epoch: string
  capabilities: readonly HostCapability[]
  brain?: boolean
  /** Owner, machine guard and `ops.run`, as on the TCP listener. */
  links: readonly FrameLinkFactory[]
  handler(connection: ReadyConnection): AuthenticatedHandler
  /** The TCP listener's connections, so `connectionsPerClient` holds across both. */
  peers?(): Iterable<{ clientId(): string | undefined }>
}

export interface LocalServerOptions {
  /** Socket paths in order of preference; the first within `socketPathBytes` is used. */
  candidates: readonly string[]
  uid: number | undefined
  hostVersion: string
  auth: Omit<LocalAuthPorts, 'hello' | 'nonces' | 'now'>
  /** What the socket serves before its lanes start, standby included: the owner adapter only. */
  links: readonly FrameLinkFactory[]
  connectionLimits?: ConnectionPorts['limits']
  log?: ApiLog
  now?: () => number
}

/** Any `Origin` header refuses a socket request: no browser has a reason to be here. */
function hasOrigin(request: IncomingMessage): boolean {
  return (
    request.headers.origin !== undefined ||
    request.rawHeaders.some((name, i) => i % 2 === 0 && name.toLowerCase() === 'origin')
  )
}

function helloRoute(
  request: IncomingMessage,
  response: ServerResponse,
  answer: (challenge: string) => object | null,
) {
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
  const body = answer(challenge)
  if (!body) {
    response.writeHead(429).end()
    return
  }
  response
    .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    .end(JSON.stringify(body))
}

/** Every request status the socket refuses, or 0. */
function requestStatus(request: IncomingMessage): number {
  if (hasOrigin(request)) return 403
  return request.method === 'GET' ? 0 : 405
}

/** The socket's HTTP side: hello only, every other request refused, raw sockets bounded. */
function helloServer(answer: (challenge: string) => object | null, log: ApiLog | undefined) {
  const raw = new Set<Socket>()
  const server = createServer(
    {
      headersTimeout: API_LIMITS.headersTimeout,
      requestTimeout: API_LIMITS.requestTimeout,
      keepAliveTimeout: API_LIMITS.keepAliveTimeout,
    },
    (request, response) => {
      const status = requestStatus(request)
      if (status) return void response.writeHead(status).end()
      helloRoute(request, response, answer)
      log?.('local.hello', {})
    },
  )
  server.on('connection', (socket) => {
    socket.on('error', () => {})
    if (raw.size >= API_LIMITS.rawSockets) return void rejectTransport(socket)
    raw.add(socket)
    socket.on('close', () => raw.delete(socket))
  })
  return { server, raw }
}

/** What the socket's connections share: the hello now, its nonces and the lanes once served. */
interface SocketState {
  hello(): HostHello
  nonces: LocalNonces
  lanes(): LocalLanes | undefined
  stopped(): boolean
  now(): number
}

/** The socket's stream route: local credentials, then the links, then the lanes once served. */
function socketUpgrades(options: LocalServerOptions, state: SocketState) {
  const limits = options.connectionLimits
  const upgrades = createWsUpgrade({
    status: (request) =>
      requestStatus(request) || (request.url !== HOST_API_ROUTES.stream ? 404 : 0),
    accepting: () => !state.stopped(),
    limits: API_LIMITS,
    sendQueueBytes: limits?.sendQueueBytes ?? HOST_LIMITS.sendQueueBytes,
    connect: (socket, ping): ReturnType<typeof createConnection> =>
      createConnection({
        socket,
        ping,
        limits,
        now: state.now,
        log: options.log,
        // In standby only the links answer; the lane adapter joins with `serveLanes`.
        handler: (ready) => {
          const lanes = state.lanes()
          return lanes
            ? createAdapterChain(lanes.links, lanes.handler)(ready)
            : createAdapterChain(options.links, undefined)(ready)
        },
        authenticate: createLocalAuth({
          ...options.auth,
          ...state,
          brain: () => state.lanes()?.brain === true,
        }),
        admit: (clientId): boolean => {
          const peers = state.lanes()?.peers?.() ?? []
          const held: number = [...upgrades.connections(), ...peers].filter(
            (c) => c.clientId() === clientId,
          ).length
          return held < (limits?.connectionsPerClient ?? HOST_LIMITS.connectionsPerClient)
        },
      }),
  })
  return upgrades
}

/** Binds the checked path, then makes the socket 0600. Returns the socket file's inode. */
async function bind(server: Server, path: string, log: ApiLog | undefined): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })
  server.on('error', () => log?.('local.error', {}))
  chmodSync(path, 0o600)
  log?.('local.listening', { bytes: utf8Length(path) })
  return lstatSync(path).ino
}

/**
 * The machine's owner socket: the same hello and frames as the TCP listener,
 * with `phosphor-local.` credentials. It serves the given links from the start
 * (standby included) and the lane adapter once `serveLanes` is called.
 */
export async function startLocalServer(options: LocalServerOptions) {
  const path = chooseSocketPath(options.candidates)
  prepareSocketFolder(dirname(path), options.uid)
  await clearStaleSocket(path)
  let lanes: LocalLanes | undefined
  let stopped = false
  const standbyEpoch = randomBytes(8).toString('hex')
  const state: SocketState = {
    hello: () => ({
      hostId: options.auth.machineId,
      hostVersion: options.hostVersion,
      protocolVersion: HOST_PROTOCOL_VERSION,
      runtimeEpoch: lanes?.epoch ?? standbyEpoch,
      capabilities: [...(lanes?.capabilities ?? [])],
    }),
    nonces: createLocalNonces(options.now),
    lanes: () => lanes,
    stopped: () => stopped,
    now: options.now ?? Date.now,
  }
  const { server, raw } = helloServer((challenge) => {
    const nonce = state.nonces.issue()
    const hello = state.hello()
    return nonce ? { hello, proof: hostProof(hello, challenge, options.auth.key), nonce } : null
  }, options.log)
  const upgrades = socketUpgrades(options, state)
  server.on('upgrade', upgrades.upgrade)
  const bound = await bind(server, path, options.log)
  const closeAll = () => {
    for (const connection of upgrades.connections()) connection.close(1001)
  }
  return {
    path,
    connections: () => upgrades.connections(),
    /**
     * The machine's lanes started: later connections get the shared lane
     * adapter and earlier ones reconnect. Stopping closes every connection
     * again, before the lanes' store closes, and serves the links only.
     */
    serveLanes(next: LocalLanes) {
      lanes = next
      closeAll()
      return {
        stop: async () => {
          if (lanes === next) lanes = undefined
          closeAll()
        },
      }
    },
    async stop() {
      stopped = true
      await upgrades.close(1001)
      for (const socket of raw) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      try {
        if (lstatSync(path).ino === bound) unlinkSync(path)
      } catch (error) {
        if (!errnoIs(error, 'ENOENT')) throw error
      }
    },
  }
}

export type LocalServer = Awaited<ReturnType<typeof startLocalServer>>
