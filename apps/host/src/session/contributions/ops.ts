import { createOpsSpawnContribution } from '@phosphor/session-runtime/pi/contributions/ops'
import type { SpawnContribution } from '@phosphor/session-runtime/pi/spawn-contributions'
import type { RunEndings } from '../../ops/lane-reload'
import type { OpsService } from '../../ops/service'

/** What the Host's lanes need from agent control: the bound service, read per use. */
export interface HostOpsLanePorts {
  /** Null until run binds the dispatcher; a lane's request then answers `no-owner`. */
  service(): OpsService | null
  /** The folder holding the bundled `pi-ext/` and `skills/`. */
  resourceRoot(): string
  /** Live sessions spawned unattended (routine runs): their asked ops answer `unattended`. */
  readonly unattended: Set<string>
  /** How each run ended, for reload-and-continue. */
  readonly endings?: Pick<RunEndings, 'ended'>
  /** Live sub-agent counts that marker lanes report, for the service pause. */
  liveness?(sessionId: string, subagents: number): void
}

/**
 * The op channel for the Host's lanes: the marker env, the `phosphor` tool and
 * skill while agent control is on, and the session binding. The lane's own op
 * dialogs are bound to their pending confirmations, and a settled run applies
 * deferred work. Null without ports, so a runtime built without agent control
 * spawns exactly as before. A reserved lane (Brain Agent's) gets no channel: its
 * only tools are its own.
 */
export function createOpsContribution(ports?: HostOpsLanePorts): SpawnContribution | null {
  if (!ports) return null
  const contribution = createOpsSpawnContribution({
    resourceRoot: () => ports.resourceRoot(),
    agentControl: async () => (await ports.service()?.agentControl()) ?? false,
    dispatcher: () => ports.service()?.dispatcher ?? null,
    liveness: (sessionId, subagents) => ports.liveness?.(sessionId, subagents),
  })
  return {
    ...contribution,
    spawn: (execution, policy) =>
      execution.reserved ? undefined : contribution.spawn(execution, policy),
    attach(session, ctx) {
      if (session.reserved) return
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
        if (event.type === 'agent_end') ports.endings?.ended(id, event.messages)
        if (event.type !== 'agent_settled') return
        ports
          .service()
          ?.dispatcher.settled(id, {})
          .catch((error: unknown) => ctx.log('ops', 'settle failed', { error: String(error) }))
      })
    },
  }
}
