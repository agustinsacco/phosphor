import type { PhosphorApi } from '@phosphor/shared/ipc'
import { enableBrainAccess, type hostBrain } from '@phosphor/host-client/brain'
import { brainClientMayInvoke, type HostBrainRequest } from '@phosphor/shared/host-brain-request'
import type { HostBrainMethod } from '@phosphor/shared/host-brain'
import type { BrainAccess } from '@phosphor/shared/brain-access'

type BrainBridge = NonNullable<PhosphorApi['hostBrain']>
type BrainTarget = Parameters<BrainBridge['invoke']>[0]
type AccessPorts = Parameters<typeof enableBrainAccess>[0]
interface BrowserBrainPorts extends AccessPorts {
  owner(): number | undefined
  client: ReturnType<typeof hostBrain>
}

/** Brain never goes through browser preferences, the worker, or the legacy IPC dispatch. */
export function createBrowserBrain(ports: BrowserBrainPorts): BrainBridge {
  function capture(target: BrainTarget, method?: HostBrainMethod) {
    const owner = ports.owner()
    const connection = ports.connection(target.hostId)
    const sameOwner = () => owner !== undefined && owner === ports.owner()
    const current = () => {
      const view = connection?.snapshot()
      return (
        sameOwner() &&
        connection === ports.connection(target.hostId) &&
        view?.state === 'ready' &&
        view.brain === true &&
        target.connectionToken === view.connectionToken &&
        (!method || brainClientMayInvoke(method, view.brainAccess ?? [], view.capabilities))
      )
    }
    return { sameOwner, current }
  }
  const changingAccess = new Set<string>()
  async function scoped<T>(
    target: BrainTarget,
    operation: () => Promise<T>,
    method?: HostBrainMethod,
  ) {
    const { current } = capture(target, method)
    if (!current()) throw unavailable()
    // Lost scope wins over the operation's own answer or failure.
    let result: T
    try {
      result = await operation()
    } catch (error) {
      if (!current()) throw unavailable()
      throw error
    }
    if (!current()) throw unavailable()
    return result
  }
  return {
    async invoke<K extends HostBrainMethod>(target: BrainTarget, request: HostBrainRequest<K>) {
      return scoped(target, () => ports.client.invoke<K>(target, request), request.method)
    },
    async access(target: BrainTarget, rights: readonly BrainAccess[]) {
      const { current, sameOwner } = capture(target)
      const id = target.hostId
      if (!current() || changingAccess.has(id)) throw unavailable()
      changingAccess.add(id)
      try {
        // Reducing rights immediately replaces the old connection in the broker. Continue
        // only for the original account and Host, not the retired connection object.
        await accessOnHost(ports, id, rights, sameOwner)
        if (!sameOwner()) throw unavailable()
      } finally {
        changingAccess.delete(id)
      }
    },
    approvals: (target: BrainTarget) =>
      scoped(target, () => ports.client.listApprovals(target.hostId)),
    answer: (target: BrainTarget, id: string, approved: boolean) =>
      scoped(target, () => ports.client.answerApproval(target.hostId, id, approved)),
  }
}

const unavailable = () => new Error('The selected Host’s Brain is unavailable.')

function accessOnHost(
  ports: AccessPorts,
  hostId: string,
  rights: readonly BrainAccess[],
  sameOwner: () => boolean,
) {
  return enableBrainAccess(
    {
      connection: ports.connection,
      grants: {
        setBrainAccess: (id, rights) => {
          if (sameOwner()) ports.grants.setBrainAccess(id, rights)
        },
        grantFor: (id) => (sameOwner() ? ports.grants.grantFor(id) : Promise.reject(unavailable())),
      },
      reconnect: (id) => (sameOwner() ? ports.reconnect(id) : Promise.reject(unavailable())),
    },
    hostId,
    rights,
  )
}
