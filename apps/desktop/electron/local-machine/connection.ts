import { fetchSocketHello, openLocalSocket } from '@phosphor/session-runtime/host-local/transport'
import { randomBytes } from 'node:crypto'
import { createHostConnection } from '@phosphor/host-client/connection'
import type { TraceLog } from '@phosphor/host-client/ports'
import type { GrantIssueResponse } from '@phosphor/shared/control-api'
import { HOST_API_ROUTES, type FrameSocket } from '@phosphor/shared/host-protocol'
import {
  LOCAL_LIMITS,
  encodeLocalCredential,
  localEndpoint,
  localGrantIssueResponse,
  type LocalIdentityFile,
} from '@phosphor/shared/host-local'
import type { OwnerKey } from '../daemon/owner-key'
import { desktopIdentity } from '../hosts/connection'
import type { LocalHostSlot } from '../hosts/manager-state'
import { localSocketPath, readLocalIdentity, type LocalDaemonLocation } from './transport'

/**
 * Desktop's connection to This Mac's own Phosphor service: the portable Host
 * connection, attested as the owner over the Unix socket. Every grant is a
 * fresh owner credential on a fresh hello nonce; nothing is cached, so a
 * 4401 simply retries. A 1001 (the service closing socket connections when
 * its lanes start or stop) reconnects through the connection's own backoff,
 * which a completed handshake resets to under a second.
 */

type Connection = ReturnType<typeof createHostConnection>
type ConnectionPorts = Parameters<typeof createHostConnection>[0]

export interface LocalMachinePorts {
  location: LocalDaemonLocation
  ownerKey: () => Promise<OwnerKey>
  uid?: number
  changed: () => void
  log?: TraceLog
  /** Each names the service's machine id, as the manager's other Hosts do. */
  traffic?: (hostId: string, ...frame: Parameters<NonNullable<ConnectionPorts['traffic']>>) => void
  onAttention?: (
    hostId: string,
    event: Parameters<NonNullable<ConnectionPorts['onAttention']>>[0],
  ) => void
  onRoutinesChanged?: (hostId: string) => void
  now?: () => number
  /** Tests replace the transport; production uses `transport.ts`. */
  transport?: {
    hello: typeof fetchSocketHello
    open: (socketPath: string) => Promise<FrameSocket>
    identity: typeof readLocalIdentity
    socketPath: typeof localSocketPath
  }
}

const defaultTransport = {
  hello: fetchSocketHello,
  open: openLocalSocket,
  identity: readLocalIdentity,
  socketPath: localSocketPath,
}

/** What the sidebar and notifications call the local service: never "This Mac" off macOS. */
export const LOCAL_MACHINE_LABEL = process.platform === 'darwin' ? 'This Mac' : 'This computer'

/** The connection to the service whose identity is `identity`; it never talks to another. */
export function createLocalMachineConnection(
  identity: LocalIdentityFile,
  ports: LocalMachinePorts,
): Connection {
  const transport = ports.transport ?? defaultTransport
  const now = ports.now ?? Date.now
  const { machineId, publicKey } = identity
  const endpoint = localEndpoint(machineId)
  /** The socket the last grant's nonce came from: the stream must open on the same one. */
  let socketPath: string | null = null
  async function grant(): Promise<GrantIssueResponse> {
    const path = transport.socketPath(ports.location, machineId, ports.uid)
    if (!path) throw new Error('offline')
    const hello = await transport.hello(path, randomBytes(32).toString('hex'))
    // Another machine's service at this path: retry; the proof check refuses it anyway.
    if (hello.hostId !== machineId) throw new Error('offline')
    const key = await ports.ownerKey()
    const at = now()
    const credential = encodeLocalCredential(
      {
        v: 1,
        kind: 'owner',
        machineId,
        client: { id: key.id, label: key.label },
        nonce: hello.nonce,
        iat: Math.floor(at / 1000),
      },
      (bytes) => key.sign(bytes),
    )
    socketPath = path
    return localGrantIssueResponse({
      machineId,
      credential,
      expiresAt: new Date(at + LOCAL_LIMITS.grantTtlSec * 1000).toISOString(),
      publicKey,
    })
  }
  return createHostConnection({
    identity: desktopIdentity,
    hostId: machineId,
    endpoint,
    local: true,
    endpointAllowed: (value) => value === endpoint,
    unrefTimer: (timer) => timer.unref(),
    socket: (url) =>
      url === `${endpoint}${HOST_API_ROUTES.stream}` && socketPath
        ? transport.open(socketPath)
        : Promise.reject(new Error('offline')),
    grant,
    clearGrant: () => {},
    changed: ports.changed,
    log: ports.log,
    traffic: (...frame) => ports.traffic?.(machineId, ...frame),
    onAttention: (event) => ports.onAttention?.(machineId, event),
    onRoutinesChanged: () => ports.onRoutinesChanged?.(machineId),
    now: ports.now,
  })
}

export const IDENTITY_RETRY_MS = 5000

/**
 * Waits for the service's identity (`setup --local` writes it), then hands
 * the host manager its local slot. Retries every 5 s until it is readable or
 * `stop` is called, so a service that is still starting is picked up later.
 */
export function startLocalMachine(
  ports: LocalMachinePorts & { attach: (slot: LocalHostSlot | null) => void },
): { stop(): void } {
  const transport = ports.transport ?? defaultTransport
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  function attempt() {
    timer = undefined
    if (stopped) return
    const identity = transport.identity(ports.location.configDir, ports.uid)
    if (!identity) {
      timer = setTimeout(attempt, IDENTITY_RETRY_MS)
      timer.unref()
      return
    }
    let clientId: string | null = null
    const ownerKey = async () => {
      const key = await ports.ownerKey()
      clientId = key.id
      return key
    }
    ports.attach({
      clientId: () => clientId,
      hostId: identity.machineId,
      label: LOCAL_MACHINE_LABEL,
      create: () => createLocalMachineConnection(identity, { ...ports, ownerKey }),
    })
  }
  attempt()
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      ports.attach(null)
    },
  }
}
