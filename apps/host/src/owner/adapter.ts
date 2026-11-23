import { isAnyLocalOwnerMethod, isOwnerMethod } from '@phosphor/shared/host-protocol-owner'
import { sendFrame, type FrameLinkFactory } from '../api/adapter'

/**
 * Owner calls, first in the chain so they work in standby with no lane
 * service. Only socket principals reach them: a grant connection's owner
 * method falls through to the lane adapter, as on every older Host. No method
 * is served yet: the owner gets `unsupported`, any other local caller
 * `forbidden` unless the method is open to every local principal.
 */
export function createOwnerAdapter(): FrameLinkFactory {
  return (connection) => {
    const kind = connection.principal?.kind
    if (kind !== 'owner' && kind !== 'local') return null
    return {
      handle(frame) {
        if (frame.type !== 'call' || !isOwnerMethod(frame.method)) return false
        const code =
          kind === 'owner' || isAnyLocalOwnerMethod(frame.method) ? 'unsupported' : 'forbidden'
        sendFrame(connection.socket, {
          type: 'result',
          id: frame.id,
          ok: false,
          error: { code, message: code },
        })
        return true
      },
    }
  }
}
