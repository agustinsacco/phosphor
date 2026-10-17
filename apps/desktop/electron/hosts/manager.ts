import { log } from '../debug-log'
import { randomUUID } from 'node:crypto'
import { machineStatus, type MachinesResponse } from '@shared/control-api'
import type { ControlResult, HostsSnapshot } from '@shared/ipc'
import { hostEndpoint, type createHostConnection, type HostConnectionSnapshot } from './connection'

export function createHostManager(ports: {
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
}) {
  const connections = new Map<
    string,
    { endpoint: string | null; connection: ReturnType<typeof createHostConnection> }
  >()
  let cached: Record<string, HostConnectionSnapshot> = {},
    list: MachinesResponse | null = null,
    offset = 0
  let user = ports.user(),
    generation = 0,
    stopped = false,
    fetching = false,
    again = false,
    disabled = false
  let debounce: ReturnType<typeof setTimeout> | undefined
  const notify = () => {
    debounce ??= setTimeout(() => {
      debounce = undefined
      ports.changed()
    }, 250)
  }
  function closeAll() {
    for (const c of connections.values()) c.connection.close()
    connections.clear()
    cached = {}
    list = null
    ports.clearGrants()
  }
  function reconcile(reset: ReadonlySet<string> = new Set(), resetReason = 'identity') {
    if (!list || !user || stopped || disabled) return
    const present = new Set(list.machines.map((m) => m.id))
    for (const id of Object.keys(cached))
      if (!present.has(id)) {
        delete cached[id]
        ports.clearGrants(id)
      }
    for (const [id, c] of connections) {
      const machine = list.machines.find((m) => m.id === id)
      if (
        !machine ||
        machineStatus(machine, Date.now(), offset) !== 'up' ||
        c.endpoint !== machine.endpoint ||
        reset.has(id)
      ) {
        log('hosts', 'manager_replacement', {
          reason: !machine
            ? 'removed'
            : machineStatus(machine, Date.now(), offset) !== 'up'
              ? 'down'
              : c.endpoint !== machine.endpoint
                ? 'endpoint'
                : resetReason,
        })
        const view = c.connection.snapshot()
        c.connection.close()
        connections.delete(id)
        ports.clearGrants(id)
        if (machine)
          cached[id] = {
            ...view,
            state: machineStatus(machine, Date.now(), offset) === 'up' ? 'reconnecting' : 'down',
          }
      }
    }
    for (const m of list.machines) {
      if (!hostEndpoint(m.endpoint, ports.testEndpoint)) {
        cached[m.id] = {
          ...cached[m.id],
          state: 'no-address',
          connectionToken: cached[m.id]?.connectionToken ?? randomUUID(),
          capabilities: cached[m.id]?.capabilities ?? [],
          repositories: cached[m.id]?.repositories ?? [],
          lanes: cached[m.id]?.lanes ?? [],
        }
        continue
      }
      if (
        machineStatus(m, Date.now(), offset) === 'up' &&
        !connections.has(m.id) &&
        connections.size < 32
      )
        connections.set(m.id, {
          endpoint: m.endpoint,
          connection: ports.connection(m.id, m.endpoint),
        })
    }
    notify()
  }
  async function refresh() {
    if (!user || stopped || disabled) return
    if (fetching) {
      again = true
      return
    }
    fetching = true
    const epoch = generation
    try {
      const result = await ports.machines()
      if (epoch === generation && !stopped && !result.ok && result.error.code === 'forbidden')
        disable()
      if (epoch === generation && !stopped && result.ok) {
        const changed = new Set(
          result.machines
            .filter((m) => {
              const previous = list?.machines.find((p) => p.id === m.id)
              return (
                previous &&
                (previous.keyFingerprint !== m.keyFingerprint ||
                  previous.enrolledAt !== m.enrolledAt)
              )
            })
            .map((m) => m.id),
        )
        list = result
        offset = Date.parse(result.serverTime) - Date.now()
        reconcile(changed)
      }
    } catch {
      /* A directory failure retains the last memory-only view. */
    } finally {
      fetching = false
      if (again) {
        again = false
        void refresh()
      }
    }
  }
  const offAccount = ports.accountChanged(() => {
    const next = ports.user()
    if (next !== user) {
      generation++
      closeAll()
      ports.resetReplacementBudget()
      user = next
      disabled = false
      notify()
    }
    void refresh()
  })
  const offMachines = ports.machinesChanged(() => {
    void refresh()
  })
  const clock = setInterval(() => reconcile(), 5000)
  void refresh()
  function disable() {
    disabled = true
    for (const [id, c] of connections) {
      cached[id] = {
        ...c.connection.snapshot(),
        state: 'reconnecting',
        lastError: 'account-disabled',
      }
      c.connection.close()
    }
    connections.clear()
    ports.clearGrants()
    notify()
  }
  return {
    changed: notify,
    connection: (hostId: string) => connections.get(hostId)?.connection,
    label: (hostId: string) => list?.machines.find((m) => m.id === hostId)?.label ?? hostId,
    present: (hostId: string) => !!list?.machines.some((m) => m.id === hostId),
    disabled: disable,
    /**
     * A user's explicit retry: re-read the directory, then replace this Host's
     * connection. It is the only way out of states that stop retrying
     * (forbidden, unsupported, wrong machine). Open lanes resync as after any
     * reconnect; nothing is resent.
     */
    async reconnect(hostId: string): Promise<void> {
      await refresh()
      reconcile(new Set([hostId]), 'requested')
    },
    snapshot(): HostsSnapshot {
      const result = structuredClone(cached)
      for (const [id, c] of connections) result[id] = c.connection.snapshot()
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
    },
    stop() {
      stopped = true
      generation++
      offAccount()
      offMachines()
      clearInterval(clock)
      closeAll()
      if (debounce) clearTimeout(debounce)
    },
  }
}
