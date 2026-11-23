import { ownerCall } from '@phosphor/host-client/owner'
import type { OwnerCalls, OwnerMethod } from '@phosphor/shared/host-protocol-owner'
import type { OwnerKey } from '../../daemon/owner-key'
import { createLocalMachineConnection, type LocalMachinePorts } from '../connection'
import type { LocalDaemonLocation } from '../transport'
import { readLocalIdentity } from '../transport'

/**
 * The launch gate's own owner connection to This Mac's service: opened
 * before the runtime mode is decided, used for `machine.local` and the
 * `owner.migrate.*` calls, and closed before the mode is decided, so the
 * host manager's connection (`admit.ts`) is the only one afterwards. Opening
 * is time-bounded; a service that does not answer is "unreachable".
 */

export interface OwnerChannel {
  readonly machineId: string
  call<M extends OwnerMethod>(
    method: M,
    params: OwnerCalls[M]['params'],
  ): Promise<OwnerCalls[M]['result']>
  close(): void
}

export const OWNER_CHANNEL_OPEN_MS = 10_000

export interface OwnerChannelPorts {
  readonly location: LocalDaemonLocation
  readonly ownerKey: () => Promise<OwnerKey>
  readonly uid?: number
  readonly timeoutMs?: number
  /** Tests replace the connection; production uses `connection.ts`. */
  readonly connect?: (
    identity: { machineId: string; publicKey: string },
    ports: LocalMachinePorts,
  ) => Pick<ReturnType<typeof createLocalMachineConnection>, 'snapshot' | 'call' | 'close'>
  readonly identity?: typeof readLocalIdentity
}

/** States after which waiting longer cannot reach `ready`. */
const TERMINAL = new Set(['unsupported', 'wrong-machine', 'no-address', 'signed-out'])

/** The channel once it is `ready`, or null when the service is not there in time. */
export function openOwnerChannel(ports: OwnerChannelPorts): Promise<OwnerChannel | null> {
  const identity = (ports.identity ?? readLocalIdentity)(ports.location.configDir, ports.uid)
  if (!identity) return Promise.resolve(null)
  const connect = ports.connect ?? createLocalMachineConnection
  return new Promise((resolve) => {
    let settled = false
    let connection: ReturnType<NonNullable<OwnerChannelPorts['connect']>> | undefined
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!ready || !connection) {
        connection?.close()
        resolve(null)
        return
      }
      const open = connection
      resolve({
        machineId: identity.machineId,
        call: (method, params) => ownerCall(open, method, params),
        close: () => open.close(),
      })
    }
    const changed = () => {
      const state = connection?.snapshot().state
      if (state === 'ready') finish(true)
      else if (state && TERMINAL.has(state)) finish(false)
    }
    const timer = setTimeout(() => finish(false), ports.timeoutMs ?? OWNER_CHANNEL_OPEN_MS)
    timer.unref?.()
    connection = connect(identity, {
      location: ports.location,
      ownerKey: ports.ownerKey,
      uid: ports.uid,
      changed: () => {
        if (!settled) changed()
      },
    })
    changed()
  })
}
