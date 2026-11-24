import { join } from 'node:path'
import {
  OP_MARKER_ENV,
  OP_MARKER_VALUE,
  noOwnerReply,
  type OpReplyEnvelope,
} from '@phosphor/shared/ops'
import type { RuntimeLog } from '../../file-log'
import type { OpsDispatcher } from '../../ops/types'
import type { SessionExecution } from '../session-policy'
import type { LiveSession } from '../session-registry'
import type { SpawnContribution, SpawnPolicyFacts } from '../spawn-contributions'

/** What an owner (Desktop main, the Host) supplies to put its lanes on the op channel. */
export interface OpsContributionPorts {
  /** The folder holding the bundled `pi-ext/` and `skills/`. */
  resourceRoot(): string
  /**
   * The agent-control switch at spawn. Off leaves out the `phosphor` tool and
   * its skill; the marker stays, because Brain reaches its owner over the channel.
   */
  agentControl(execution: SessionExecution, policy: SpawnPolicyFacts): boolean | Promise<boolean>
  /** Read per request, so a dispatcher bound after startup still serves earlier lanes. */
  dispatcher(): Pick<OpsDispatcher, 'runFromTool' | 'cancelLane'> | null
  /** Live sub-agent counts that marker lanes report, for a service pause. */
  liveness?(sessionId: string, subagents: number): void
}

const unavailable = (id: string): OpReplyEnvelope => ({
  v: 1,
  id,
  status: 'error',
  code: 'unavailable',
  text: 'Phosphor could not run this operation.',
})

/**
 * Serves one session's op channel from the owner's dispatcher. Every request
 * is answered: the dispatcher's reply, `no-owner` while no dispatcher is
 * bound, or `unavailable` when it throws. Stop and exit cancel the lane's
 * queued and deferred ops; the client already answered its pending ids.
 */
export function bindOpChannel(
  session: LiveSession,
  ports: Pick<OpsContributionPorts, 'dispatcher' | 'liveness'>,
  log: RuntimeLog,
): void {
  const { client, sessionId } = session
  client.on('phosphor-op', ({ request, respond }) => {
    const dispatcher = ports.dispatcher()
    if (!dispatcher) return respond(noOwnerReply(request.id))
    dispatcher.runFromTool(sessionId, request).then(respond, (error: unknown) => {
      log('pi', 'op failed', { sessionId, error: String(error) })
      respond(unavailable(request.id))
    })
  })
  const cancel = () => ports.dispatcher()?.cancelLane(sessionId)
  client.on('phosphor-op-stop', cancel)
  client.on('exit', cancel)
  const { liveness } = ports
  if (liveness) client.on('lane-liveness', (subagents) => liveness(sessionId, subagents))
}

/**
 * The op channel's spawn contribution: the marker env, the `phosphor` tool and
 * its skill, and the session binding. Each owner's `contributions/ops.ts`
 * returns one of these.
 */
export function createOpsSpawnContribution(ports: OpsContributionPorts): SpawnContribution {
  return {
    name: 'ops',
    async spawn(execution, policy) {
      const env = { [OP_MARKER_ENV]: OP_MARKER_VALUE }
      if (!(await ports.agentControl(execution, policy))) return { env }
      const root = ports.resourceRoot()
      return {
        env,
        extensions: [join(root, 'pi-ext', 'phosphor.ts')],
        skills: [join(root, 'skills', 'phosphor')],
      }
    },
    attach: (session, { log }) => bindOpChannel(session, ports, log),
  }
}
