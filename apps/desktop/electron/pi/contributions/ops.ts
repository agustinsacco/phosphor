import { createOpsSpawnContribution } from '@phosphor/session-runtime/pi/contributions/ops'
import type { SpawnContribution } from '@phosphor/session-runtime/pi/spawn-contributions'
import { policyStore } from '../../prefs/agent-policy'
import { resourceRoot } from '../session-launch'
import { activeDesktopOps } from '../../ops/lifecycle'
import { rememberOpLane } from '../../ops/lanes'

export function createOpsContribution(): SpawnContribution {
  const contribution = createOpsSpawnContribution({
    resourceRoot,
    agentControl: async () => (await policyStore.read()).policy.agentControl !== 'off',
    dispatcher: () => ({
      runFromTool: async (id, request) =>
        (await import('../../ops/service')).desktopOps().runFromTool(id, request),
      cancelLane: (id) => activeDesktopOps()?.cancelLane(id),
    }),
  })
  return {
    ...contribution,
    attach(session, ctx) {
      const id = session.sessionId
      const forget = rememberOpLane(session, ctx.options.name, ctx.execution.unattended === true)
      contribution.attach?.(session, ctx)
      session.client.on('extension-ui', (r) => {
        if (r.method === 'confirm') activeDesktopOps()?.confirmSeen(id, r)
      })
      session.client.on('event', (e) => {
        if (e.type === 'agent_settled')
          activeDesktopOps()
            ?.settled(id, {})
            .catch((error: unknown) => ctx.log('ops', 'settle failed', { error: String(error) }))
      })
      session.client.on('exit', forget)
    },
  }
}
