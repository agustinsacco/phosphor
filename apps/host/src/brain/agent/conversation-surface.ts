/**
 * What authorized clients do with Brain Agent's conversation: show, send, take, stop and answer.
 * Every act is checked again after its last await, against the exact process, turn, controller
 * and fence it names, immediately before its one side effect.
 */
import { BRAIN_TELL_MAX } from '@phosphor/shared/brain'
import type { ExtensionUIResponse } from '@phosphor/shared/rpc'
import type { BrainSurfaceAuthority } from '../../api/brain-adapter'
import type { BrainAgentSurfacePage, BrainSurfaceAgent } from '../surface-service'
import type { ConversationControl } from './conversation-control'
import { dialogAnswerFits } from './conversation-dialogs'
import { conversationEntries, conversationPage } from './conversation-page'
import {
  inspectInteractive,
  LaneBusy,
  liveId,
  openInteractive,
  sameInteractive,
  type ConversationProcess,
  type DialogAsker,
} from './conversation-process'
import { controllerTurn, startedBy } from './conversation-turns'
import { messagingQualified } from './profile'

type AgentResult = Awaited<ReturnType<BrainSurfaceAgent['send']>>

/** pi runs "/" (commands, skills, templates) and "!" (shell) input outside the tool guard. */
const COMMAND_FORM = /^[/!]/

/** Whether `text` may go as a person's message on this Host at all. */
const sendable = (process: ConversationProcess, text: string) =>
  messagingQualified(process.ports.profile) &&
  text.length > 0 &&
  text.length <= BRAIN_TELL_MAX &&
  !COMMAND_FORM.test(text)

async function prompt(
  process: ConversationProcess,
  control: ConversationControl,
  message: string,
  caller: BrainSurfaceAuthority,
  at: number,
): Promise<AgentResult> {
  const text = message.trim()
  if (!sendable(process, text)) return 'unavailable'
  let opened: Awaited<ReturnType<typeof openInteractive>>
  try {
    opened = await openInteractive(process)
    const inspected = await inspectInteractive(process, opened.id)
    if (inspected !== 'ready') return inspected === 'busy' ? 'busy' : 'unavailable'
    if (!sameInteractive(process, opened.id, opened.generation)) return 'unavailable'
  } catch (error) {
    return error instanceof LaneBusy ? 'busy' : 'unavailable'
  }
  const { id, generation } = opened
  if (!control.current(caller, at)) return 'not-controller'
  const identity = controllerTurn(caller)
  if (!process.turns.claim(identity)) return 'busy'
  const { reserved } = process.ports
  // The service can wait on compaction and provider preflight before writing to stdin.
  const response = await reserved
    .command(
      id,
      { type: 'prompt', message: text },
      () =>
        sameInteractive(process, id, generation) &&
        process.turns.mayDispatch(identity) &&
        control.current(caller, at),
    )
    .catch(() => null)
  if (response?.success) return 'ok'
  process.turns.release(identity)
  if (!control.current(caller, at)) return 'not-controller'
  // pi refuses a plain prompt once a turn has started first.
  return response && (await process.history.busy(id).catch(() => false)) ? 'busy' : 'unavailable'
}

/** A question from this process's current turn, which `caller` started. */
function answerable(
  { state, turns }: ConversationProcess,
  asker: DialogAsker,
  caller: BrainSurfaceAuthority,
): boolean {
  const turn = turns.named()
  return asker.generation === state.generation && asker.turn === turn && startedBy(turn, caller)
}

async function page(
  process: ConversationProcess,
  control: ConversationControl,
  cursor: string | null,
  caller: BrainSurfaceAuthority,
): Promise<BrainAgentSurfacePage> {
  if (!caller.admit()) throw new Error('Brain Agent was not authorized.')
  const { history, state, turns, dialogs } = process
  const id = liveId(process)
  const [messages, running, at] = await Promise.all([
    history.messages(id),
    id ? history.busy(id) : false,
    control.fence(),
  ])
  const entries = conversationEntries(messages, running ? state.streaming : null)
  const turn = turns.running()
  return {
    ...conversationPage(entries, cursor),
    dialogs: dialogs.list(({ asker }) => answerable(process, asker, caller)),
    fence: at,
    controller: control.controller(),
    running,
    turn: turn && startedBy(turn, caller) ? turn.ref : null,
    messaging: messagingQualified(process.ports.profile),
  }
}

async function stop(
  process: ConversationProcess,
  control: ConversationControl,
  [expected, ref]: [number, string],
  caller: BrainSurfaceAuthority,
): Promise<AgentResult> {
  const admitted = await control.admit(expected, caller, false)
  if (typeof admitted === 'string') return admitted
  const id = liveId(process)
  const turn = process.turns.running()
  if (!id || turn?.ref !== ref || turn.kind !== 'controller') return 'stale'
  if (!startedBy(turn, caller) || !control.current(caller, admitted.fence)) return 'not-controller'
  // Stop closes the curator gate before asking pi; its abort may wait for a tool to return.
  if (!process.turns.cancel(turn)) return 'stale'
  let skipped = false
  const beforeDispatch = () => {
    skipped = liveId(process) !== id || process.turns.running() !== turn
    return !skipped
  }
  const response = await process.ports.reserved
    .command(id, { type: 'abort' }, beforeDispatch)
    .catch(() => null)
  return skipped ? 'stale' : response?.success ? 'ok' : 'unavailable'
}

async function answer(
  process: ConversationProcess,
  control: ConversationControl,
  [response, expected]: [ExtensionUIResponse, number],
  caller: BrainSurfaceAuthority,
): Promise<AgentResult> {
  const admitted = await control.admit(expected, caller, false)
  if (typeof admitted === 'string') return admitted
  const id = liveId(process)
  const asked = process.dialogs.get(response.id)
  if (!id || !asked || !answerable(process, asked.asker, caller)) return 'not-found'
  if (!dialogAnswerFits(asked.request, response)) return 'unavailable'
  if (!control.current(caller, admitted.fence)) return 'not-controller'
  try {
    process.ports.reserved.respond(id, response)
  } catch {
    return 'unavailable'
  }
  process.dialogs.close(response.id)
  return 'ok'
}

export function conversationSurface(
  process: ConversationProcess,
  control: ConversationControl,
): BrainSurfaceAgent {
  const show = (cursor: string | null, caller: BrainSurfaceAuthority) =>
    page(process, control, cursor, caller)
  return {
    show,
    watch: show,
    async tell(message, caller) {
      if (!sendable(process, message.trim()) || !caller.admit()) return 'unavailable'
      const at = await control.fence()
      if (control.heldByOther(caller)) return 'not-controller'
      return prompt(process, control, message, caller, at)
    },
    async send(message, expected, caller) {
      // A message that cannot go never takes control.
      if (!sendable(process, message.trim())) return 'unavailable'
      const admitted = await control.admit(expected, caller, true)
      if (typeof admitted === 'string') return admitted
      return prompt(process, control, message, caller, admitted.fence)
    },
    take: (expected, caller) => control.take(expected, caller),
    stop: (expected, ref, caller) => stop(process, control, [expected, ref], caller),
    answer: (response, expected, caller) => answer(process, control, [response, expected], caller),
  }
}
