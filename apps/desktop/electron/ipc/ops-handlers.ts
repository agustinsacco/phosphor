import { parseOpsRunRequest, type OpsRunResult } from '@shared/host-protocol-ops'
import { handle } from './handle'

/** What `ops:run` answers until This Mac and the Host bindings serve catalog ops. */
export const OPS_NOT_SERVED: OpsRunResult = {
  status: 'denied',
  code: 'unsupported',
  text: 'This version of Phosphor does not run agent ops yet.',
}

/** Agent control as a surface: one catalog op on This Mac or a Host. */
export function registerOpsHandlers(): void {
  handle('ops:run', async (event, target, raw) => {
    if (target?.kind !== 'local') return OPS_NOT_SERVED
    const request = parseOpsRunRequest(raw)
    if (!request || request.actor)
      return { status: 'denied', code: 'bad-request', text: 'Invalid local surface operation.' }
    return (await import('../ops/service'))
      .desktopOps()
      .run(
        { kind: 'surface', via: 'owner', label: 'This Mac', clientId: String(event.sender.id) },
        request,
      )
  })
}
