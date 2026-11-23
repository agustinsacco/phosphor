import { parseOpsRunRequest, type OpsRunResult } from '@shared/host-protocol-ops'
import { opsRun } from '@phosphor/host-client/ops'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import { localRuntimeMode } from '../local-machine/mode'
import { sameMachine } from '../local-machine/same-machine'
import { handle } from './handle'

type OpsConnection = Parameters<typeof opsRun>[0]

/** What `ops:run` answers until This Mac and the Host bindings serve catalog ops. */
export const OPS_NOT_SERVED: OpsRunResult = {
  status: 'denied',
  code: 'unsupported',
  text: 'This version of Phosphor does not run agent ops yet.',
}
export const OPS_HOST_UNREACHABLE: OpsRunResult = {
  status: 'denied',
  code: 'unavailable',
  text: "That machine isn't connected. Try again when it's back.",
}
export const OPS_SERVICE_NOT_READY: OpsRunResult = {
  status: 'denied',
  code: 'unavailable',
  text: "This Mac's Phosphor service isn't ready yet. Try again in a moment.",
}
const BAD_REQUEST: OpsRunResult = {
  status: 'denied',
  code: 'bad-request',
  text: 'Invalid surface operation.',
}

let hostConnection: ((hostId: string) => OpsConnection | undefined) | null = null

/** The host manager's connections; ops for a Host go over its own connection. */
export function bindOpsHosts(connection: ((hostId: string) => OpsConnection | undefined) | null) {
  hostConnection = connection
}

/** A static `read` tier is a call; anything else, unknown ops included, is a write never resent. */
const isWrite = (op: string) => OP_CATALOG.find((spec) => spec.name === op)?.tier !== 'read'

/** One op on a connected machine. The machine derives the surface principal from the connection. */
export async function runOnHost(hostId: string, raw: unknown): Promise<OpsRunResult> {
  const request = parseOpsRunRequest(raw)
  if (!request || request.actor) return BAD_REQUEST
  const connection = hostConnection?.(hostId)
  if (!connection) return OPS_HOST_UNREACHABLE
  return opsRun(connection, request, { write: isWrite(request.op) })
}

/**
 * Agent control as a surface: one catalog op on This Mac or a Host. In daemon
 * mode This Mac's lanes belong to its service, so a local op goes there and
 * never to the in-app binding.
 */
export function registerOpsHandlers(): void {
  handle('ops:run', async (event, target, raw) => {
    if (target?.kind === 'remote') return runOnHost(target.hostId, raw)
    if (target?.kind !== 'local') return OPS_NOT_SERVED
    if (localRuntimeMode() === 'daemon') {
      const service = sameMachine()
      return service ? runOnHost(service.hostId, raw) : OPS_SERVICE_NOT_READY
    }
    const request = parseOpsRunRequest(raw)
    if (!request || request.actor) return BAD_REQUEST
    return (await import('../ops/service'))
      .desktopOps()
      .run(
        { kind: 'surface', via: 'owner', label: 'This Mac', clientId: String(event.sender.id) },
        request,
      )
  })
}
