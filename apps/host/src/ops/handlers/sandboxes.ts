import { dataResult, fields, op, pageInventory } from '@phosphor/session-runtime/ops/results'
import type { DaemonHandlerDeps } from './index'

export function sandboxHandlers(deps: DaemonHandlerDeps) {
  function service() {
    if (!deps.sandboxes) throw new Error('Sandbox service is unavailable.')
    return deps.sandboxes
  }
  return {
    'sandbox.list': op((_, c) => pageInventory(service().list(), c, fields('name', 'path'))),
    'sandbox.create': op<{ name: string }>(async ({ name }) =>
      dataResult(await service().create(name)),
    ),
    'sandbox.rename': op<{ path: string; name: string }>(async ({ path, name }, ctx) =>
      dataResult(
        await service().change(
          path,
          name,
          ctx.principal.kind === 'surface' && ctx.principal.via === 'owner',
        ),
      ),
    ),
    'sandbox.delete': op<{ path: string }>(async ({ path }, ctx) =>
      dataResult(
        await service().change(
          path,
          null,
          ctx.principal.kind === 'surface' && ctx.principal.via === 'owner',
        ),
      ),
    ),
  }
}
