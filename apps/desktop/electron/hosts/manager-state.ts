import type { MachinesResponse } from '@shared/control-api'
import type { ControlResult, HostsSnapshot } from '@shared/ipc'
import type { createHostConnection, HostConnectionSnapshot } from './connection'

export type HostManagerPorts = {
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

export interface HostManagerState {
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

export function createHostManagerState(user: string | null): HostManagerState {
  return {
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

export function hostManagerSnapshot(
  state: HostManagerState,
  ports: Pick<HostManagerPorts, 'clientId'>,
): HostsSnapshot {
  const result = structuredClone(state.cached)
  for (const [id, c] of state.connections) result[id] = c.connection.snapshot()
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
                  self: control.controller.clientId === clientId,
                }
              : null,
          },
        })),
      },
    ]),
  )
}
