/**
 * Brain Agent's conversation on a Host: the reserved lane's one live process, its transcript and
 * its open questions, shown to authorized clients and driven by one controller at a time.
 *
 * - The fence lives in the binding and only increases, across restarts: any take changes it, so
 *   a message, Stop or answer sent against an older page is refused, never applied to a newer
 *   state. A sender with no controller in place becomes the controller.
 * - A message never interrupts a turn: while one runs, `send` and `tell` answer `busy`.
 * - Stop names the turn its client saw (`turn` on the page) and ends only that turn, while it
 *   still runs and only when the caller started it. Defrag's turn is stopped only through its
 *   signal (`agent-lane.ts`), and Defrag's Stop never ends the owner's turn.
 * - A question is answerable only by the controller whose running turn asked it, in the process
 *   that asked it, once. A question from Defrag, an earlier turn or a replaced process is not
 *   shown and not answered; pi's own timeout ends it. Nothing here answers one on anyone's behalf.
 * - A person's message runs only from a qualified interactive launch (`profile.ts`). With none,
 *   as in production today, Send and Tell refuse before pi starts, control changes or a
 *   transcript binds. Before every prompt the exact live process proves it loaded the tool guard
 *   and matches that launch. Command form never goes: pi runs "/" commands outside the guard.
 *   Defrag runs in the broad profile. Switching restarts the lane on the same transcript, only
 *   while no turn runs, and never while Defrag holds the lane.
 * - Each turn is named before its prompt goes (`conversation-turns.ts`); Brain Agent's tools
 *   answer only under the running turn's gate. A new process starts with no turn or question.
 *
 * The live process is `conversation-process.ts`, control and the fence `conversation-control.ts`,
 * and what clients do `conversation-surface.ts`; this file composes them with Defrag's turns.
 */
import type { RpcCommand, RpcResponse } from '@phosphor/shared/rpc'
import type { ReservedLaneRuntime, ReservedOpen } from '../../session/reserved-lanes'
import type { BrainAgentBindingFile } from './binding'
import { createConversationControl } from './conversation-control'
import {
  createConversationProcess,
  liveId,
  openProcess,
  type ConversationProcess,
} from './conversation-process'
import { conversationSurface } from './conversation-surface'
import { defragTurn } from './conversation-turns'
import type { BrainAgentLaunchProfile } from './profile'

export interface BrainAgentConversationPorts {
  reserved: Pick<ReservedLaneRuntime, 'open' | 'client' | 'command' | 'respond' | 'stop'>
  binding: BrainAgentBindingFile
  /** Shared with the curator contribution, which reads `next` as the lane spawns. */
  profile: BrainAgentLaunchProfile
  folder: string
  sessionsRoot: string
  log(message: string, data?: Record<string, unknown>): void
}

/** Defrag's prompt, named as Defrag's turn; refused like a mid-turn prompt while one holds. */
async function defragCommand(
  process: ConversationProcess,
  id: string,
  command: RpcCommand,
): Promise<RpcResponse> {
  const { reserved } = process.ports
  if (command.type !== 'prompt') return reserved.command(id, command)
  const identity = defragTurn()
  if (
    liveId(process) !== id ||
    process.state.profile !== 'defrag' ||
    !process.turns.claim(identity)
  )
    return { type: 'response', command: 'prompt', success: false, error: 'Brain Agent is busy.' }
  try {
    const response = await reserved.command(id, command)
    if (!response.success) process.turns.release(identity)
    return response
  } catch (error) {
    process.turns.release(identity)
    throw error
  }
}

/** For Defrag's turns: the broad profile, on the same transcript and binding as the owner's. */
function defragLane(process: ConversationProcess) {
  const { state, ports } = process
  return {
    open: (request: ReservedOpen) => openProcess(process, request, 'defrag'),
    command: (id: string, command: RpcCommand) => defragCommand(process, id, command),
    resume: process.history.resume,
    bind: (file: string | null) => ports.binding.bind(file).then(() => {}),
    /** Holds the lane for one Defrag turn, so a person's message does not restart it under it. */
    async hold<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
      state.defrag++
      state.defragSignal = signal
      try {
        return await work()
      } finally {
        if (--state.defrag === 0) state.defragSignal = null
      }
    },
    /** The runtime's own Tell names no person, so it carries no authority on a Host. */
    tell: async (_message: string): Promise<never> => {
      throw new Error('Message Brain Agent from its conversation on this Host.')
    },
  }
}

export function createBrainAgentConversation(ports: BrainAgentConversationPorts) {
  const process = createConversationProcess(ports)
  return {
    surface: conversationSurface(process, createConversationControl(ports.binding)),
    /** The running turn's gate for Brain Agent's tools (`BrainAgentHost.turnGate`). */
    turnGate: process.turns.gate,
    lane: defragLane(process),
  }
}

export type BrainAgentConversation = ReturnType<typeof createBrainAgentConversation>
