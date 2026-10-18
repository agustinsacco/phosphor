import {
  createHostConnection,
  hostEndpoint,
  type HostConnectionSnapshot,
} from '@phosphor/host-client/connection'
import { openHostSocket } from '@phosphor/host-client/socket'
import { browserCrypto, type IdentityCrypto } from '@phosphor/host-client/crypto'
import {
  machineStatus,
  formatKeyFingerprint,
  type MachineView,
  type GrantIssueResponse,
} from '@phosphor/shared/control-api'
import { HOST_LIMITS, type FrameSocket, type AttentionEvent } from '@phosphor/shared/host-protocol'
import type { HostsSnapshot } from '@phosphor/shared/ipc'
import type { BrowserControl } from './control'

type Connection = ReturnType<typeof createHostConnection>
export interface HostPorts {
  control: BrowserControl
  socket?: (url: string) => Promise<FrameSocket>
  identity?: IdentityCrypto
  changed: () => void
  routinesChanged: (hostId: string) => void
  attention: (hostId: string, event: AttentionEvent) => void
  now?: () => number
}
/** Directory, grants and connections belong to exactly one in-memory cookie generation. */
export function createBrowserHosts(ports: HostPorts) {
  const identity = ports.identity ?? browserCrypto,
    now = ports.now ?? Date.now
  const entries = new Map<
    string,
    { machine: MachineView; connection?: Connection; cached: HostConnectionSnapshot }
  >()
  const grants = new Map<string, GrantIssueResponse>()
  const flights = new Map<string, { promise: Promise<GrantIssueResponse>; token: object }>()
  let generation = 0,
    sequence = 0,
    offset = 0,
    stopped = false
  let directoryReady = false
  const changed = () =>
    queueMicrotask(() => {
      if (!stopped) ports.changed()
    })
  function clear() {
    generation++
    sequence++
    for (const entry of entries.values()) entry.connection?.close()
    entries.clear()
    directoryReady = false
    grants.clear()
    flights.clear()
    changed()
  }
  function drop(hostId: string) {
    const entry = entries.get(hostId)
    entry?.connection?.close()
    if (entry) entry.connection = undefined
    grants.delete(hostId)
    flights.delete(hostId)
  }
  async function grant(machine: MachineView): Promise<GrantIssueResponse> {
    const epoch = generation,
      owner = ports.control.generation()
    const cached = grants.get(machine.id)
    if (cached && Date.parse(cached.expiresAt) - HOST_LIMITS.renewBeforeSec * 1000 > now())
      return cached
    const flight = flights.get(machine.id)
    if (flight) return flight.promise
    const token = {}
    const promise = (async () => {
      const value = await ports.control.grant(machine.id)
      // Bind grant metadata to the exact directory entry, including enrolled key fingerprint.
      const raw = Uint8Array.from(
        atob(value.host.publicKey.replace(/-/g, '+').replace(/_/g, '/')),
        (c) => c.charCodeAt(0),
      )
      const fingerprint = formatKeyFingerprint(
        new Uint8Array(await crypto.subtle.digest('SHA-256', raw)),
      )
      if (
        stopped ||
        epoch !== generation ||
        owner !== ports.control.generation() ||
        entries.get(machine.id)?.machine !== machine ||
        flights.get(machine.id)?.token !== token
      )
        throw new Error('signed-out')
      const remaining = Date.parse(value.expiresAt) - now()
      if (
        value.host.id !== machine.id ||
        value.host.endpoint !== machine.endpoint ||
        fingerprint !== machine.keyFingerprint ||
        remaining <= 0 ||
        remaining > 330_000
      )
        throw new Error('grant-refused')
      grants.set(machine.id, value)
      return value
    })()
    flights.set(machine.id, { promise, token })
    void promise
      .finally(() => {
        if (flights.get(machine.id)?.token === token) flights.delete(machine.id)
      })
      .catch(() => {})
    return promise
  }
  function reconcile() {
    if (stopped || !ports.control.session()) return
    for (const [hostId, entry] of entries) {
      const up = machineStatus(entry.machine, now(), offset) === 'up'
      if (!up || !hostEndpoint(entry.machine.endpoint)) {
        if (entry.connection) entry.cached = entry.connection.snapshot()
        drop(hostId)
        entry.cached = { ...entry.cached, state: up ? 'no-address' : 'down' }
      } else if (!entry.connection) {
        const epoch = generation
        const active = () => !stopped && epoch === generation && entries.get(hostId) === entry
        entry.connection = createHostConnection({
          hostId,
          endpoint: entry.machine.endpoint,
          identity,
          socket: ports.socket ?? openHostSocket,
          grant: () => grant(entry.machine),
          clearGrant: () => grants.delete(hostId),
          changed: () => {
            if (active()) changed()
          },
          onRoutinesChanged: () => {
            if (active()) ports.routinesChanged(hostId)
          },
          onAttention: (event) => {
            if (active()) ports.attention(hostId, event)
          },
          now,
        })
      }
    }
    changed()
  }
  async function refresh() {
    const request = ++sequence,
      epoch = generation
    const result = await ports.control.machines()
    if (stopped || epoch !== generation || request !== sequence) return result
    if (!result.ok) {
      directoryReady = false
      return result
    }
    // Duplicate ids make endpoint ownership ambiguous; do not admit the directory.
    if (
      result.machines.length > 32 ||
      new Set(result.machines.map((m) => m.id)).size !== result.machines.length
    ) {
      directoryReady = false
      return {
        ok: false as const,
        error: {
          code: 'unavailable' as const,
          message: 'Invalid or oversized machine directory (maximum 32 Hosts).',
        },
      }
    }
    directoryReady = true
    for (const id of entries.keys())
      if (!result.machines.some((m) => m.id === id)) {
        drop(id)
        entries.delete(id)
      }
    offset = Date.parse(result.serverTime) - now()
    for (const machine of result.machines) {
      const previous = entries.get(machine.id)
      if (
        previous &&
        (previous.machine.endpoint !== machine.endpoint ||
          previous.machine.keyFingerprint !== machine.keyFingerprint ||
          previous.machine.enrolledAt !== machine.enrolledAt)
      ) {
        drop(machine.id)
        entries.delete(machine.id)
      }
      const entry = entries.get(machine.id)
      if (entry) {
        // Keep the identity object stable for in-flight grants while refreshing liveness metadata.
        entry.machine = Object.assign(entry.machine, machine)
      } else
        entries.set(machine.id, {
          machine: { ...machine },
          cached: {
            connectionToken: identity.randomUUID(),
            state: 'connecting',
            capabilities: [],
            repositories: [],
            lanes: [],
          },
        })
    }
    reconcile()
    return result
  }
  return {
    refresh,
    directoryReady: () => directoryReady,
    reconcile,
    clear,
    connection: (id: string) => entries.get(id)?.connection,
    present: (id: string) => entries.has(id),
    label: (id: string) => entries.get(id)?.machine.label ?? 'Host',
    async reconnect(id: string) {
      const epoch = generation
      const result = await refresh()
      if (epoch !== generation || !result.ok || !entries.has(id))
        throw new Error('Host unavailable.')
      drop(id)
      reconcile()
    },
    snapshot(): HostsSnapshot {
      const clientId = ports.control.session()?.clientId
      return Object.fromEntries(
        [...entries].map(([id, e]) => {
          const view = e.connection?.snapshot() ?? structuredClone(e.cached)
          return [
            id,
            {
              ...view,
              lanes: view.lanes.map(({ control, ...lane }) => ({
                ...lane,
                control: {
                  fence: control.fence,
                  controller: control.controller
                    ? {
                        label: control.controller.label,
                        connected: control.controller.connected,
                        self: control.controller.clientId === clientId,
                      }
                    : null,
                },
              })),
            },
          ]
        }),
      )
    },
    dispose() {
      stopped = true
      clear()
    },
  }
}
export type BrowserHosts = ReturnType<typeof createBrowserHosts>
