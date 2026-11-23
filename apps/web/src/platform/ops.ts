import { OPS_HOST_TOO_OLD, opsRun } from '@phosphor/host-client/ops'
import { REMOTE_UNAVAILABLE } from '@phosphor/host-client/lane-ops'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import type { BrowserHandlers } from './handlers'
import type { BrowserHosts } from './hosts'

/** A browser is a surface on the selected Host. It has no This Mac fallback. */
export function opsHandlers(connection: BrowserHosts['connection']) {
  return {
    'ops:run': async (target, request) => {
      if (target.kind !== 'remote')
        return {
          status: 'denied',
          code: 'unsupported',
          text: 'This Mac is unavailable in the browser.',
        }
      const host = connection(target.hostId)
      const view = host?.snapshot()
      if (!host || view?.state !== 'ready') throw Error(REMOTE_UNAVAILABLE)
      if (!view.ops) return { status: 'denied', code: 'unsupported', text: OPS_HOST_TOO_OLD }
      const spec = OP_CATALOG.find((s) => s.name === request.op)
      if (!spec) return { status: 'denied', code: 'unsupported', text: 'Unknown agent operation.' }
      return opsRun(host, request, { write: spec.tier !== 'read' })
    },
  } satisfies Partial<BrowserHandlers>
}
