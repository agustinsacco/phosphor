import { randomUUID } from 'node:crypto'
import type { BrainAccess } from '@phosphor/shared/brain-access'
import type { FrameSocket } from '@phosphor/shared/host-protocol'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { FrameLinkFactory } from '../adapter'
import type { ConnectionPrincipal } from '../principal'
import type { ReadyConnection } from '../connection'

/** One connection on a Brain link: `run` sends an `ops.run` call (read) or command (write). */
export function bindBrainLink(
  kind: ConnectionPrincipal['kind'],
  adapter: FrameLinkFactory,
  brainAccess: readonly BrainAccess[] = [],
  clientId = randomUUID(),
  caps: readonly HostCapability[] = [],
  label = 'Harbor',
) {
  let finish: (result: OpsRunResult) => void
  const socket = {
    isOpen: () => true,
    bufferedBytes: () => 0,
    send: (text: string) => {
      const frame = JSON.parse(text) as { data?: OpsRunResult; receipt?: { data?: OpsRunResult } }
      finish((frame.data ?? frame.receipt?.data)!)
    },
  } as FrameSocket
  const connection: ReadyConnection = {
    connectionId: randomUUID(),
    client: { id: clientId, label },
    principal:
      kind === 'grant-machine' ? { kind, clientId, machineId: randomUUID() } : { kind, clientId },
    socket,
    caps,
    brainAccess,
    credentialLive: () => true,
  }
  const link = adapter(connection)!
  function run(op: string, args: Record<string, unknown>, write = false, extra = {}) {
    return new Promise<OpsRunResult>((resolve) => {
      finish = resolve
      const wire = { op, args, ...extra }
      link.handle(
        write
          ? { type: 'command', requestId: randomUUID(), op: { type: 'ops.run', ...wire } }
          : { type: 'call', id: randomUUID(), method: 'ops.run', params: wire },
        [],
      )
    })
  }
  return {
    run,
    renew: (rights?: readonly BrainAccess[], next: readonly HostCapability[] = caps) =>
      link.renew?.(next, rights),
    clientId,
    close: () => link.close?.(),
  }
}
