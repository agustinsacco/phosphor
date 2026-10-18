import {
  createHostManagerState,
  hostManagerSnapshot,
  notifyHostManager,
  type HostManagerPorts,
} from './manager-state'
import {
  closeAllHosts,
  disableHostManager,
  reconcileHostManager,
  refreshHostManager,
} from './manager-reconcile'

export function createHostManager(ports: HostManagerPorts) {
  const state = createHostManagerState(ports.user())
  const notify = () => notifyHostManager(state, ports)
  const refresh = () => refreshHostManager(state, ports)
  const offAccount = ports.accountChanged(() => {
    const next = ports.user()
    if (next !== state.user) {
      state.generation++
      closeAllHosts(state, ports)
      ports.resetReplacementBudget()
      state.user = next
      state.disabled = false
      notify()
    }
    void refresh()
  })
  const offMachines = ports.machinesChanged(() => {
    void refresh()
  })
  const clock = setInterval(() => reconcileHostManager(state, ports), 5000)
  void refresh()
  return {
    changed: notify,
    connection: (hostId: string) => state.connections.get(hostId)?.connection,
    label: (hostId: string) => state.list?.machines.find((m) => m.id === hostId)?.label ?? hostId,
    present: (hostId: string) => !!state.list?.machines.some((m) => m.id === hostId),
    disabled: () => disableHostManager(state, ports),
    /**
     * A user's explicit retry: re-read the directory, then replace this Host's
     * connection. It is the only way out of states that stop retrying
     * (forbidden, unsupported, wrong machine). Open lanes resync as after any
     * reconnect; nothing is resent.
     */
    async reconnect(hostId: string): Promise<void> {
      await refresh()
      reconcileHostManager(state, ports, new Set([hostId]), 'requested')
    },
    snapshot: () => hostManagerSnapshot(state, ports),
    stop() {
      state.stopped = true
      state.generation++
      offAccount()
      offMachines()
      clearInterval(clock)
      closeAllHosts(state, ports)
      if (state.debounce) clearTimeout(state.debounce)
    },
  }
}
