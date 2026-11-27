/**
 * The Host's Brain Agent lane, composed once per Host: the reserved lane's runtime handle, its
 * stable binding, the conversation clients see and the Defrag turns Brain runs there. Defrag uses
 * the same turn logic as Desktop (`@phosphor/brain-runtime/agent/agent-lane`) over the same open
 * and delivery as the owner's messages, so there is one process and one transcript. Nothing is
 * created on disk until the lane's first turn or message.
 */
import { dirname, join } from 'node:path'
import { createBrainAgentLane } from '@phosphor/brain-runtime/agent/agent-lane'
import type { BrainAgentHost } from '@phosphor/brain-runtime/types'
import type { ReservedLane } from '@phosphor/session-runtime/pi/reserved-lane'
import type { HostRuntime } from '../../session/runtime'
import type { BrainSurfaceAgent } from '../surface-service'
import { createBrainAgentBinding, type BrainAgentBindingFile } from './binding'
import { createBrainAgentConversation } from './conversation'
import type { BrainAgentLaunchProfile } from './profile'

export interface HostBrainAgentPorts {
  runtime: Pick<HostRuntime, 'reserve'>
  /** `hostBrainAgentReservation(state)`, the object the curator contribution holds too. */
  lane: ReservedLane
  /** pi's sessions root (`piSessionsRoot`): stopped history is read only from inside it. */
  sessionsRoot: string
  binding?: BrainAgentBindingFile
  /** The launch profile the curator contribution reads (`profile.ts`). */
  profile: BrainAgentLaunchProfile
  log(message: string, data?: Record<string, unknown>): void
}

export interface HostBrainAgentLane {
  /** Real path: Brain never reads a lane here. */
  readonly folder: string
  /** `HostBrainOptions.agent`: Defrag turns and the gate Brain Agent's tools answer under. */
  readonly host: BrainAgentHost
  /** `BrainSurfacePorts.agent`: show, watch, tell, send, take, stop and answer. */
  readonly surface: BrainSurfaceAgent
}

export function createHostBrainAgentLane(ports: HostBrainAgentPorts): HostBrainAgentLane {
  const { folder } = ports.lane
  const reserved = ports.runtime.reserve(ports.lane)
  const binding = ports.binding ?? createBrainAgentBinding(join(dirname(folder), 'agent-lane.json'))
  const conversation = createBrainAgentConversation({
    reserved,
    binding,
    folder,
    sessionsRoot: ports.sessionsRoot,
    profile: ports.profile,
    log: ports.log,
  })
  const turns = createBrainAgentLane({
    folder,
    resume: conversation.lane.resume,
    bind: conversation.lane.bind,
    create: (options) =>
      conversation.lane.open(
        options.sessionPath ? { sessionPath: options.sessionPath } : { name: options.name },
      ),
    client: (sessionId) => reserved.client(sessionId),
    command: conversation.lane.command,
    changed: () => {},
  })
  const host: BrainAgentHost = {
    folder,
    turn: (message, signal, hooks) =>
      conversation.lane.hold(signal, () => turns.turn(message, signal, hooks)),
    tell: conversation.lane.tell,
    turnGate: conversation.turnGate,
  }
  return { folder, host, surface: conversation.surface }
}
