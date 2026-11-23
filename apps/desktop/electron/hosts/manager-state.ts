import { DirectoryDedupe } from './dedupe'
import type { MachinesResponse } from '@shared/control-api'
import type { ControlResult, HostsSnapshot } from '@shared/ipc'
import type { createHostConnection } from './connection'
import type { HostConnectionSnapshot } from '@phosphor/host-client/connection'

export type HostManagerPorts = {
  directory?: DirectoryDedupe
  testEndpoint?: string
  user: () => string | null
  clientId: () => string | null
  resetReplacementBudget: () => void
  accountChanged: (cb: () => void) => () => void
  machinesChanged: (cb: () => void) => () => void
  machines: () => Promise<ControlResult<MachinesResponse>>
  connection: (hostId: string, endpoint: string | null) => ReturnType<typeof createHostConnection>
  clearGrants: (hostId?: string) => void
  changed: () => void
}

/**
 * This machine's own service, reached over its Unix socket. It is not in the
 * directory, needs no sign-in or grant, and is outside the 32-socket cap.
 */
export interface LocalHostSlot {
  /** Identity used to attest on the socket, independent of the directory account. */
  clientId?: () => string | null
  hostId: string
  label: string
  create: () => ReturnType<typeof createHostConnection>
}

export interface HostManagerState {
  directory: DirectoryDedupe
  local?: LocalHostSlot & { connection: ReturnType<typeof createHostConnection> }
  connections: Map<
    string,
    { endpoint: string | null; connection: ReturnType<typeof createHostConnection> }
  >
  cached: Record<string, HostConnectionSnapshot>
  list: MachinesResponse | null
  offset: number
  user: string | null
  generation: number
  stopped: boolean
  fetching: boolean
  again: boolean
  disabled: boolean
  debounce: ReturnType<typeof setTimeout> | undefined
}

export function createHostManagerState(
  user: string | null,
  directory = new DirectoryDedupe(),
): HostManagerState {
  return {
    directory,
    connections: new Map(),
    cached: {},
    list: null,
    offset: 0,
    user,
    generation: 0,
    stopped: false,
    fetching: false,
    again: false,
    disabled: false,
    debounce: undefined,
  }
}

export function notifyHostManager(state: HostManagerState, ports: HostManagerPorts) {
  state.debounce ??= setTimeout(() => {
    state.debounce = undefined
    ports.changed()
  }, 250)
}

export function managerClientId(
  state: HostManagerState,
  hostId: string,
  directoryClientId: string | null,
) {
  return hostId === state.local?.hostId ? (state.local.clientId?.() ?? null) : directoryClientId
}

export function hostManagerSnapshot(
  state: HostManagerState,
  ports: Pick<HostManagerPorts, 'clientId'>,
): HostsSnapshot {
  const result = structuredClone(state.cached)
  for (const [id, c] of state.connections) result[id] = c.connection.snapshot()
  const alias = state.directory.get()
  if (alias) delete result[alias]
  if (state.local)
    result[state.local.hostId] = {
      ...state.local.connection.snapshot(),
      local: true,
      ...(alias ? { enrolledHostId: alias } : {}),
    }
  const clientId = ports.clientId()
  return Object.fromEntries(
    Object.entries(result).map(([id, view]) => [
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
                  self: control.controller.clientId === managerClientId(state, id, clientId),
                }
              : null,
          },
        })),
      },
    ]),
  )
}
