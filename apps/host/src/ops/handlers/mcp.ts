import { parseSettingsPatch } from '@phosphor/shared/machine-settings'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { dataResult, op } from '@phosphor/session-runtime/ops/results'
import { patchSection, projectId, readSection, scopedProject, settingsOps } from './settings-access'
import type { DaemonHandlerDeps } from './index'

export function mcpHandlers(deps: DaemonHandlerDeps) {
  const mutate = (action: 'add' | 'update' | 'enable' | 'disable' | 'remove') =>
    op(async (a, c) => {
      const id = projectId(deps, scopedProject(a.scope, a.project), c)
      const before = await readSection(deps, 'connectors', id, c.signal)
      const name = String(a.name)
      if (action === 'add' || action === 'update') {
        const change = { type: 'mcp.upsert', name, config: a.config, approveCode: true }
        if (action === 'add') await patchSection(deps, before, change, c)
        else {
          const input = parseSettingsPatch({
            section: 'connectors',
            repositoryId: id,
            revision: before.revision,
            change,
          })
          if (input?.change.type !== 'mcp.upsert')
            throw new OpRefusal('bad-request', 'Invalid connector configuration.')
          const settings = settingsOps(deps).settings
          const cwd = settings.workspace(id)
          await settings.replaceConnector(
            input.change,
            before,
            cwd,
            before.revision,
            () => !c.signal.aborted && settings.workspace(id) === cwd,
            true,
          )
        }
      } else
        await patchSection(
          deps,
          before,
          action === 'remove'
            ? { type: 'mcp.remove', name }
            : { type: 'mcp.enabled', name, enabled: action === 'enable' },
          c,
        )
      // No full connector snapshot goes to audit. Its private attributes cannot be reconstructed.
      return { text: `Saved connector change: ${name}.`, undo: false }
    })
  return {
    'mcp.list': op(async (a, c) =>
      dataResult(
        (await readSection(deps, 'connectors', projectId(deps, a.project, c), c.signal)).connectors,
      ),
    ),
    'mcp.check': op(async (a, c) => {
      const { connectors } = await readSection(
        deps,
        'connectors',
        projectId(deps, a.project, c),
        c.signal,
      )
      const server = connectors?.servers.find((s) => s.name === a.name)
      if (!server) throw new OpRefusal('bad-request', 'No such connector in this scope.')
      return {
        text: `${server.name}: ${server.state ?? 'not checked'}. Cached status only; use Settings for a live check.`,
        data: server,
      }
    }),
    'mcp.add': mutate('add'),
    'mcp.update': mutate('update'),
    'mcp.enable': mutate('enable'),
    'mcp.disable': mutate('disable'),
    'mcp.remove': mutate('remove'),
  }
}
