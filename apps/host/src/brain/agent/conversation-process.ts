/**
 * The one live process of Brain Agent's reserved lane, as the conversation sees it: which process
 * and profile run, its turns and questions, and the reply in flight. Starts and restarts go one
 * at a time; a new process starts with no turn, question or reply from the one it replaced, and
 * pushes from a replaced process are ignored.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { BRAIN_AGENT_NAME } from '@phosphor/shared/brain-agent'
import type { LiveSessionInfo, SessionPush } from '@phosphor/shared/models'
import type { RpcSessionState } from '@phosphor/shared/rpc'
import { ensureBrainLane } from '@phosphor/brain-runtime/agent/rules'
import { piState } from '../../lanes/pi-results'
import type { ReservedOpen } from '../../session/reserved-lanes'
import type { BrainAgentConversationPorts } from './conversation'
import { createConversationDialogs } from './conversation-dialogs'
import { createConversationHistory } from './conversation-history'
import { createTurnIdentities, type TurnIdentity } from './conversation-turns'
import { guardLoaded, type BrainAgentProfileKind } from './profile'

/** Who asked a question: the process generation and the turn named then. */
export interface DialogAsker {
  readonly generation: number
  readonly turn: TurnIdentity | null
}

interface ProcessState {
  live: string | null
  /** The live process's profile. */
  profile: BrainAgentProfileKind | null
  sessionFile: string | null
  /** Ignores pushes from a process this conversation already replaced. */
  generation: number
  /** Defrag turns holding the lane: a person's message does not restart it under them. */
  defrag: number
  /** The holding Defrag turn's stop: it also ends Defrag's wait for a person's turn. */
  defragSignal: AbortSignal | null
  /** Counts turns pi starts: the reply in flight is shown under its turn's entry id. */
  turn: number
  streaming: { turn: number; text: string } | null
}

export interface ConversationProcess {
  readonly ports: BrainAgentConversationPorts
  readonly state: ProcessState
  readonly turns: ReturnType<typeof createTurnIdentities>
  readonly dialogs: ReturnType<typeof createConversationDialogs<DialogAsker>>
  readonly history: ReturnType<typeof createConversationHistory>
  /** Starts and restarts one at a time: two callers never start two processes. */
  lifecycle: Promise<unknown>
}

const STREAM_CHARS = 16 * 1024
const IDLE_POLL_MS = 100

export class LaneBusy extends Error {}

export function createConversationProcess(ports: BrainAgentConversationPorts) {
  const process: ConversationProcess = {
    ports,
    state: {
      live: null,
      profile: null,
      sessionFile: null,
      generation: 0,
      defrag: 0,
      defragSignal: null,
      turn: 0,
      streaming: null,
    },
    dialogs: createConversationDialogs<DialogAsker>(),
    turns: createTurnIdentities((identity) => {
      const id = liveId(process)
      const stillNamed = () => liveId(process) === id && process.turns.named() === identity
      if (id) void ports.reserved.command(id, { type: 'abort' }, stillNamed).catch(() => undefined)
    }),
    history: createConversationHistory(ports),
    lifecycle: Promise.resolve(),
  }
  return process
}

export function liveId({ state, ports }: ConversationProcess): string | null {
  return state.live && ports.reserved.client(state.live)?.alive ? state.live : null
}

/** No turn, question or reply carries over to another process. */
function forget({ state, turns, dialogs }: ConversationProcess): void {
  state.streaming = null
  turns.exit()
  dialogs.clear()
}

function event(
  { state, turns }: ConversationProcess,
  push: Extract<SessionPush, { kind: 'event' }>,
) {
  const { event } = push
  turns.event(event.type)
  if (event.type === 'agent_start') state.streaming = { turn: ++state.turn, text: '' }
  else if (event.type === 'agent_settled') state.streaming = null
  else if (state.streaming && (event.type === 'message_start' || event.type === 'message_end'))
    state.streaming.text = ''
  else if (
    state.streaming &&
    event.type === 'message_update' &&
    event.assistantMessageEvent.type === 'text_delta'
  )
    state.streaming.text = (state.streaming.text + event.assistantMessageEvent.delta).slice(
      0,
      STREAM_CHARS,
    )
}

/** One process's delivery; stderr never reaches a client. */
function deliverer(process: ConversationProcess, generation: number) {
  const { state, turns, dialogs } = process
  return (push: SessionPush): void => {
    if (generation !== state.generation) return
    if (push.kind === 'event') event(process, push)
    else if (push.kind === 'extension-ui')
      dialogs.open(push.request, { generation, turn: turns.named() })
    else if (push.kind === 'exit') {
      state.live = null
      state.profile = null
      state.sessionFile = null
      forget(process)
    }
  }
}

function exclusive<T>(process: ConversationProcess, work: () => Promise<T>): Promise<T> {
  const next = process.lifecycle.then(work, work)
  process.lifecycle = next.catch(() => undefined)
  return next
}

async function idle(process: ConversationProcess, id: string, signal: AbortSignal | null) {
  while (liveId(process) === id) {
    if (!(await process.history.busy(id)) && !process.turns.named()) break
    signal?.throwIfAborted()
    await sleep(IDLE_POLL_MS)
  }
  signal?.throwIfAborted()
}

/**
 * The live process in `kind`'s profile, restarting the lane on its transcript when the live one
 * has the other. A person's message never waits: it is busy while a turn runs or Defrag holds
 * the lane. Defrag waits for the person's turn to settle first.
 */
export function openProcess(
  process: ConversationProcess,
  kind: BrainAgentProfileKind,
  name = BRAIN_AGENT_NAME,
): Promise<LiveSessionInfo & { generation: number }> {
  const { state, ports } = process
  return exclusive(process, async () => {
    const id = liveId(process)
    if (id && state.profile === kind)
      return { sessionId: id, workspacePath: ports.folder, generation: state.generation }
    if (id) {
      if (kind === 'defrag') await idle(process, id, state.defragSignal)
      else if ((await process.history.busy(id)) || state.defrag > 0 || process.turns.named())
        throw new LaneBusy()
      await ports.reserved.stop(id)
    }
    const generation = ++state.generation
    state.live = null
    state.profile = null
    state.sessionFile = null
    forget(process)
    // Resolve the binding after waiting for the other profile to finish and save.
    const sessionPath = await process.history.resume()
    const request: ReservedOpen = sessionPath ? { sessionPath } : { name }
    ports.profile.next = kind
    const info = await ports.reserved.open(request, deliverer(process, generation))
    try {
      const live = await readLaunchState(ports, info.sessionId, kind)
      if (!live || live.isStreaming || live.isCompacting)
        throw new Error('Brain Agent’s launch did not match.')
      const file = await process.history.acceptFile(live.sessionFile, sessionPath)
      await ports.binding.bind(file)
      if (!ports.reserved.client(info.sessionId)?.alive)
        throw new Error('Brain Agent’s lane closed during startup.')
      state.live = info.sessionId
      state.profile = kind
      state.sessionFile = file
      return { ...info, generation }
    } catch (error) {
      // Never expose a process that reports another conversation to page or prompt callers.
      if (ports.reserved.client(info.sessionId)?.alive) await ports.reserved.stop(info.sessionId)
      throw error
    }
  })
}

export async function openInteractive(process: ConversationProcess) {
  await ensureBrainLane(process.ports.folder)
  const { sessionId, generation } = await openProcess(process, 'interactive')
  return { id: sessionId, generation }
}

/** Still the interactive process `id` this conversation opened as `generation`. */
export const sameInteractive = (process: ConversationProcess, id: string, generation: number) =>
  liveId(process) === id &&
  process.state.generation === generation &&
  process.state.profile === 'interactive'

/**
 * Whether the exact process `id` may take a person's prompt now: it loaded the guard, matches
 * the qualified launch and runs no turn.
 */
export async function inspectInteractive(
  { ports, state }: ConversationProcess,
  id: string,
): Promise<'ready' | 'busy' | 'unqualified'> {
  const live = await readLaunchState(ports, id, 'interactive')
  if (!live || live.sessionFile !== state.sessionFile) return 'unqualified'
  return live.isStreaming || live.isCompacting ? 'busy' : 'ready'
}

/** Process consistency only: a response from pi cannot prove execution closure. */
async function readLaunchState(
  { reserved, profile }: BrainAgentConversationPorts,
  id: string,
  kind: BrainAgentProfileKind,
): Promise<RpcSessionState | null> {
  const reported = await reserved.command(id, { type: 'get_state' })
  const live = reported.success ? piState(reported.data) : null
  if (!live || kind === 'defrag') return live
  const { guard, qualified } = profile
  if (!guard || !qualified?.matches(live)) return null
  const commands = await reserved.command(id, { type: 'get_commands' })
  return commands.success && guardLoaded(commands.data, guard) ? live : null
}
