import { SettingsFailure } from '@phosphor/session-runtime/pi/settings-file'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { dataResult, op } from '@phosphor/session-runtime/ops/results'
import { projectId, readSection, scopedProject, settingsOps } from './settings-access'
import type { DaemonHandlerDeps } from './index'

export function mcpHandlers(deps: DaemonHandlerDeps) {
  const mutate = (action: 'add' | 'update' | 'enable' | 'disable' | 'remove') =>
    op(async (a, c) => {
      const id = projectId(deps, scopedProject(a.scope, a.project), c)
      const before = await readSection(deps, 'connectors', id, c.signal)
      const name = String(a.name)
      const change =
        action === 'add' || action === 'update'
          ? { type: 'mcp.upsert', name, config: a.config }
          : action === 'remove'
            ? { type: 'mcp.remove', name }
            : { type: 'mcp.enabled', name, enabled: action === 'enable' }
      try {
        await settingsOps(deps).settings.changeAgentConnector(
          before,
          change,
          action === 'update',
          () => !c.signal.aborted,
        )
      } catch (error) {
        if (error instanceof SettingsFailure)
          throw new OpRefusal(error.code === 'internal' ? 'unavailable' : error.code, error.message)
        throw error
      }
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
