import {
  createHostManagerState,
  hostManagerSnapshot,
  notifyHostManager,
  type HostManagerPorts,
  type LocalHostSlot,
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
  const local = (hostId: string) => (state.local?.hostId === hostId ? state.local : undefined)
  /** The local slot is replaced only here: never by the directory, the account or `disabled`. */
  function setLocal(slot: LocalHostSlot | null) {
    state.local?.connection.close()
    state.local = slot && !state.stopped ? { ...slot, connection: slot.create() } : undefined
    notify()
  }
  return {
    changed: notify,
    connection: (hostId: string) =>
      local(hostId)?.connection ?? state.connections.get(hostId)?.connection,
    label: (hostId: string) =>
      local(hostId)?.label ?? state.list?.machines.find((m) => m.id === hostId)?.label ?? hostId,
    present: (hostId: string) =>
      !!local(hostId) || !!state.list?.machines.some((m) => m.id === hostId),
    setLocal,
    disabled: () => disableHostManager(state, ports),
    /**
     * A user's explicit retry: re-read the directory, then replace this Host's
     * connection. It is the only way out of states that stop retrying
     * (forbidden, unsupported, wrong machine). Open lanes resync as after any
     * reconnect; nothing is resent.
     */
    async reconnect(hostId: string): Promise<void> {
      const slot = local(hostId)
      if (slot) return setLocal(slot)
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
      state.local?.connection.close()
      state.local = undefined
      if (state.debounce) clearTimeout(state.debounce)
    },
  }
}
