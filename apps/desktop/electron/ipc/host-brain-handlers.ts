import { enableBrainAccess, hostBrain } from '@phosphor/host-client/brain'
import { parseBrainAccess } from '@phosphor/shared/brain-access'
import type { BrainSurfaceScope } from '@shared/ipc/host-brain'
import type { createHostManager } from '../hosts/manager'
import { handle } from './handle'

type Manager = Pick<ReturnType<typeof createHostManager>, 'connection' | 'reconnect'>
type Grants = Parameters<typeof enableBrainAccess>[0]['grants']

/** No selection lookup here: permissions and approvals belong to the view which requested them. */
export function registerHostBrainHandlers(manager: Manager, grants: Grants): void {
  function scoped(scope: BrainSurfaceScope) {
    if (!scope || typeof scope.hostId !== 'string' || typeof scope.connectionToken !== 'string')
      throw new Error('Brain connection changed.')
    const connection = manager.connection(scope.hostId, scope.connectionToken)
    if (!connection || connection.snapshot().state !== 'ready')
      throw new Error('Brain connection changed.')
    const lookup = (hostId: string) =>
      hostId === scope.hostId && manager.connection(hostId, scope.connectionToken) === connection
        ? connection
        : undefined
    return { lookup, api: hostBrain(lookup) }
  }
  handle('hosts:brainApprovals', async (_event, scope) =>
    scoped(scope).api.listApprovals(scope.hostId),
  )
  handle('hosts:brainAnswer', async (_event, scope, id, approved) => {
    const { api } = scoped(scope)
    if (typeof id !== 'string' || id.length > 128 || typeof approved !== 'boolean')
      throw new Error('Invalid Brain approval.')
    await api.answerApproval(scope.hostId, id, approved)
  })
  handle('hosts:brainAccess', async (_event, scope, input) => {
    const { lookup } = scoped(scope)
    const rights = parseBrainAccess(input)
    if (!rights) throw new Error('Invalid Brain access request.')
    await enableBrainAccess(
      {
        connection: lookup,
        grants,
        reconnect: async (hostId) => {
          if (!lookup(hostId)) throw new Error('Brain connection changed.')
          await manager.reconnect(hostId)
        },
      },
      scope.hostId,
      rights,
    )
  })
}
