import { createOpsSpawnContribution } from '@phosphor/session-runtime/pi/contributions/ops'
import type { SpawnContribution } from '@phosphor/session-runtime/pi/spawn-contributions'
import type { OpsService } from '../../ops/service'

/** What the Host's lanes need from agent control: the bound service, read per use. */
export interface HostOpsLanePorts {
  /** Null until run binds the dispatcher; a lane's request then answers `no-owner`. */
  service(): OpsService | null
  /** The folder holding the bundled `pi-ext/` and `skills/`. */
  resourceRoot(): string
  /** Live sessions spawned unattended (routine runs): their asked ops answer `unattended`. */
  readonly unattended: Set<string>
}

/**
 * The op channel for the Host's lanes: the marker env, the `phosphor` tool and
 * skill while agent control is on, and the session binding. The lane's own op
 * dialogs are bound to their pending confirmations, and a settled run applies
 * deferred work. Null without ports, so a runtime built without agent control
 * spawns exactly as before.
 */
export function createOpsContribution(ports?: HostOpsLanePorts): SpawnContribution | null {
  if (!ports) return null
  const contribution = createOpsSpawnContribution({
    resourceRoot: () => ports.resourceRoot(),
    agentControl: async () => (await ports.service()?.agentControl()) ?? false,
    dispatcher: () => ports.service()?.dispatcher ?? null,
  })
  return {
    ...contribution,
    attach(session, ctx) {
      contribution.attach?.(session, ctx)
      const id = session.sessionId
      if (ctx.execution.unattended === true) {
        ports.unattended.add(id)
        session.client.on('exit', () => ports.unattended.delete(id))
      }
      session.client.on('extension-ui', (request) => {
        if (request.method === 'confirm') ports.service()?.dispatcher.confirmSeen(id, request)
      })
      session.client.on('event', (event) => {
        if (event.type !== 'agent_settled') return
        ports
          .service()
          ?.dispatcher.settled(id, {})
          .catch((error: unknown) => ctx.log('ops', 'settle failed', { error: String(error) }))
      })
    },
  }
}
