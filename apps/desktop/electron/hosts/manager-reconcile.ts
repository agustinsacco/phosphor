import { randomUUID } from 'node:crypto'
import { machineStatus } from '@shared/control-api'
import { log } from '../debug-log'
import { hostEndpoint } from './connection'
import { notifyHostManager, type HostManagerState, type HostManagerPorts } from './manager-state'

export function closeAllHosts(state: HostManagerState, ports: HostManagerPorts) {
  for (const c of state.connections.values()) c.connection.close()
  state.connections.clear()
  state.cached = {}
  state.list = null
  ports.clearGrants()
}

export function reconcileHostManager(
  state: HostManagerState,
  ports: HostManagerPorts,
  reset: ReadonlySet<string> = new Set(),
  resetReason = 'identity',
) {
  if (!state.list || !state.user || state.stopped || state.disabled) return
  const present = new Set(state.list.machines.map((m) => m.id))
  for (const id of Object.keys(state.cached))
    if (!present.has(id)) {
      delete state.cached[id]
      ports.clearGrants(id)
    }
  for (const [id, c] of state.connections) {
    const machine = state.list.machines.find((m) => m.id === id)
    if (
      !machine ||
      machineStatus(machine, Date.now(), state.offset) !== 'up' ||
      c.endpoint !== machine.endpoint ||
      reset.has(id)
    ) {
      log('hosts', 'manager_replacement', {
        reason: !machine
          ? 'removed'
          : machineStatus(machine, Date.now(), state.offset) !== 'up'
            ? 'down'
            : c.endpoint !== machine.endpoint
              ? 'endpoint'
              : resetReason,
      })
      const view = c.connection.snapshot()
      c.connection.close()
      state.connections.delete(id)
      ports.clearGrants(id)
      if (machine)
        state.cached[id] = {
          ...view,
          laneStarts: [],
          state:
            machineStatus(machine, Date.now(), state.offset) === 'up' ? 'reconnecting' : 'down',
        }
    }
  }
  for (const m of state.list.machines) {
    if (!hostEndpoint(m.endpoint, ports.testEndpoint)) {
      state.cached[m.id] = {
        ...state.cached[m.id],
        state: 'no-address',
        connectionToken: state.cached[m.id]?.connectionToken ?? randomUUID(),
        capabilities: state.cached[m.id]?.capabilities ?? [],
        repositories: state.cached[m.id]?.repositories ?? [],
        lanes: state.cached[m.id]?.lanes ?? [],
      }
      continue
    }
    if (
      machineStatus(m, Date.now(), state.offset) === 'up' &&
      !state.connections.has(m.id) &&
      state.connections.size < 32
    )
      state.connections.set(m.id, {
        endpoint: m.endpoint,
        connection: ports.connection(m.id, m.endpoint),
      })
  }
  notifyHostManager(state, ports)
}

export async function refreshHostManager(state: HostManagerState, ports: HostManagerPorts) {
  if (!state.user || state.stopped || state.disabled) return
  if (state.fetching) {
    state.again = true
    return
  }
  state.fetching = true
  const epoch = state.generation
  try {
    const result = await ports.machines()
    if (
      epoch === state.generation &&
      !state.stopped &&
      !result.ok &&
      result.error.code === 'forbidden'
    )
      disableHostManager(state, ports)
    if (epoch === state.generation && !state.stopped && result.ok) {
      const changed = new Set(
        result.machines
          .filter((m) => {
            const previous = state.list?.machines.find((p) => p.id === m.id)
            return (
              previous &&
              (previous.keyFingerprint !== m.keyFingerprint || previous.enrolledAt !== m.enrolledAt)
            )
          })
          .map((m) => m.id),
      )
      state.list = result
      state.offset = Date.parse(result.serverTime) - Date.now()
      reconcileHostManager(state, ports, changed)
    }
  } catch {
    /* A directory failure retains the last memory-only view. */
  } finally {
    state.fetching = false
    if (state.again) {
      state.again = false
      void refreshHostManager(state, ports)
    }
  }
}

export function disableHostManager(state: HostManagerState, ports: HostManagerPorts) {
  state.disabled = true
  for (const [id, c] of state.connections) {
    state.cached[id] = {
      ...c.connection.snapshot(),
      laneStarts: [],
      state: 'reconnecting',
      lastError: 'account-disabled',
    }
    c.connection.close()
  }
  state.connections.clear()
  ports.clearGrants()
  notifyHostManager(state, ports)
}
