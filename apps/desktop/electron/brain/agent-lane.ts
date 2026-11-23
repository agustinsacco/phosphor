/**
 * Brain Agent's turns in the Brain lane, an ordinary lane in `<userData>/brain/Brain`. Each
 * Defrag turn resumes the folder's newest transcript (or starts the lane) the way the owner
 * opens a lane: no window target, not unattended, so its events reach every window and its
 * dialogs reach the owner. The message goes through the session service's `command`, so the
 * usual prompt preflight runs.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BRAIN_AGENT_NAME } from '@phosphor/shared/brain-agent'
import type {
  BrainAgentHost,
  BrainAgentTurn,
  BrainAgentTurnHooks,
} from '@phosphor/brain-runtime/types'
import type { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import type { SessionExecution } from '@phosphor/session-runtime/pi/session-policy'
import { lastAssistantEnd } from '@phosphor/session-runtime/routines/outcome'
import type { CreateSessionOptions, LiveSessionInfo } from '@shared/models'
import type { AgentMessage, PiEvent, RpcCommand, RpcResponse } from '@shared/rpc'
import { ensureBrainLane, readBrainRules } from './lane-folder'

export type BrainLaneClient = Pick<PiRpcClient, 'alive' | 'sessionFile' | 'request' | 'on' | 'off'>

export interface BrainLaneDeps {
  /** Real path of the Brain lane's folder. */
  folder: string
  /** pi's transcript folder for `folder` (`sessionDirForCwd`). */
  transcripts(folder: string): string
  /** `spawnSession` with no target, not unattended: the live lane when it is already open. */
  create(options: CreateSessionOptions, execution: SessionExecution): Promise<LiveSessionInfo>
  client(sessionId: string): BrainLaneClient | undefined
  /** `desktopSessions.command`, so a prompt gets the usual preflight. */
  command(sessionId: string, command: RpcCommand): Promise<RpcResponse>
  /** Broadcast `sessions:changed` for the folder. */
  changed(folder: string): void
}

type TurnEnd = Pick<BrainAgentTurn, 'outcome' | 'error'>
interface OpenLane {
  sessionId: string
  client: BrainLaneClient
}

export const BRAIN_LANE_CLOSED = 'Brain Agent’s lane closed before the turn ended.'

/** The newest transcript pi keeps for the folder, or null before the lane's first turn. */
export async function newestTranscript(directory: string): Promise<string | null> {
  const names = await readdir(directory).catch(() => [] as string[])
  const dated = await Promise.all(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map(async (name) => {
        const path = join(directory, name)
        const info = await stat(path).catch(() => null)
        return info?.isFile() ? { path, at: info.mtimeMs } : null
      }),
  )
  const found = dated.filter((entry) => entry !== null).sort((a, b) => b.at - a.at)
  return found[0]?.path ?? null
}

const text = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Resolves once the lane has no turn or compaction; rejects when it closes or
 * `signal` aborts. A turn the owner started is theirs to finish: waiting never aborts it. It
 * listens before it asks, and asks again when a turn settles or a compaction ends, so an end
 * pi prints with the busy state it answered is never missed.
 */
function settled({ client }: OpenLane, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let waiting = true
    const done = (error?: Error) => {
      if (!waiting) return
      waiting = false
      client.off('event', onEvent)
      client.off('exit', onExit)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const check = () =>
      idle(client).then(
        (yes) => {
          if (yes) done()
        },
        (error: unknown) => done(error instanceof Error ? error : new Error(text(error))),
      )
    const onEvent = (event: PiEvent) => {
      if (event.type === 'agent_settled' || event.type === 'compaction_end') void check()
    }
    const onExit = () => done(new Error(BRAIN_LANE_CLOSED))
    const onAbort = () => done(new Error('stopped'))
    client.on('event', onEvent)
    client.on('exit', onExit)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) return onAbort()
    void check()
  })
}

async function idle(client: BrainLaneClient): Promise<boolean> {
  const state = await client.request({ type: 'get_state' })
  if (!state.success || !state.data) throw new Error('Brain Agent’s lane did not answer.')
  // pi's own idle. Messages a stopped turn left queued wait for the next prompt, as they would
  // for one of the owner's: no turn will deliver them before it.
  return !state.data.isStreaming && !state.data.isCompacting
}

/**
 * How a run that will not retry ended, from its last assistant message: a provider error fails
 * with pi's message, an abort (the owner's Stop in the lane) stops, and no answer at all fails.
 */
function runEnd(messages: AgentMessage[]): TurnEnd {
  const end = lastAssistantEnd(messages)
  if (end.kind === 'ended') return { outcome: 'finished', error: null }
  if (end.kind === 'aborted') return { outcome: 'stopped', error: null }
  return {
    outcome: 'failed',
    error: end.kind === 'error' ? (end.message.errorMessage ?? null) : null,
  }
}

/**
 * Sends the message once the lane settles and resolves when its turn ends, stops or fails.
 * Brain Agent answers Defrag only from when pi accepts the message: an owner's message that
 * passed its preflight as the lane settled reaches pi first, pi refuses Defrag's as it refuses
 * any plain prompt mid-turn, and Defrag waits for the owner's turn and sends again.
 */
async function prompt(
  deps: BrainLaneDeps,
  lane: OpenLane,
  message: string,
  signal: AbortSignal,
  sending: () => void,
): Promise<TurnEnd> {
  for (;;) {
    await settled(lane, signal)
    const end = await send(deps, lane, message, signal, sending)
    if (end) return end
  }
}

/** One try at the message: null when pi refused it because a turn started first. */
function send(
  deps: BrainLaneDeps,
  { sessionId, client }: OpenLane,
  message: string,
  signal: AbortSignal,
  sending: () => void,
): Promise<TurnEnd | null> {
  return new Promise((resolve) => {
    let accepted = false
    let started = false
    let done = false
    const finish = (end: TurnEnd | null) => {
      if (done) return
      done = true
      client.off('event', onEvent)
      client.off('response', onResponse)
      client.off('exit', onExit)
      signal.removeEventListener('abort', onAbort)
      resolve(end)
    }
    // An end can arrive before the message's waiter resumes. pi prints a prompt's response
    // before its turn's events, so only an end after this message's own response is its turn's.
    const responses: string[] = []
    const ends: { after: number; end: TurnEnd }[] = []
    const ending = (end: TurnEnd) => {
      if (accepted) finish(end)
      else ends.push({ after: responses.length, end })
    }
    const onResponse = (response: RpcResponse) => {
      if (response.id) responses.push(response.id)
    }
    const onEvent = (event: PiEvent) => {
      if (event.type === 'agent_start') started = true
      if (event.type === 'agent_end' && !event.willRetry) ending(runEnd(event.messages))
      // A slash command's error is another command's: Defrag's message is plain text.
      if (event.type === 'extension_error' && event.event !== 'command')
        ending({ outcome: 'failed', error: `Extension error: ${event.error}` })
    }
    const onExit = () => finish({ outcome: 'failed', error: BRAIN_LANE_CLOSED })
    const abort = () => void deps.command(sessionId, { type: 'abort' }).catch(() => undefined)
    // A message pi has not accepted may wait behind the owner's: only Defrag's own turn stops.
    const onAbort = () => {
      if (accepted) abort()
      finish({ outcome: 'stopped', error: null })
    }
    const answered = async (response: RpcResponse) => {
      if (response.success) {
        // Stopped while the message waited: end the turn pi has just started for it.
        if (done) {
          if (signal.aborted) abort()
          return
        }
        accepted = true
        sending()
        const own = response.id ? responses.indexOf(response.id) : -1
        const end = ends.find(({ after }) => after > own)
        if (end) finish(end.end)
        return
      }
      if (done) return
      const owner = started || !(await idle(client).catch(() => true))
      finish(
        owner ? null : { outcome: 'failed', error: response.error ?? 'pi refused the message.' },
      )
    }
    client.on('event', onEvent)
    client.on('response', onResponse)
    client.on('exit', onExit)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) return onAbort()
    if (!client.alive) return onExit()
    deps
      .command(sessionId, { type: 'prompt', message })
      .then(answered)
      .catch((error: unknown) => finish({ outcome: 'failed', error: text(error) }))
  })
}

/** Resumes the newest transcript or starts the lane, and learns its transcript at once. */
async function open(deps: BrainLaneDeps, opened: BrainAgentTurnHooks['opened']): Promise<OpenLane> {
  const sessionPath = await newestTranscript(deps.transcripts(deps.folder))
  // Defrag never moves the folder Phosphor reopens at launch; the owner opening the lane does.
  const live = await deps.create(
    { workspacePath: deps.folder, ...(sessionPath ? { sessionPath } : { name: BRAIN_AGENT_NAME }) },
    { keepLastWorkspace: true },
  )
  const client = deps.client(live.sessionId)
  if (!client) throw new Error(BRAIN_LANE_CLOSED)
  // The registry matches an opened path on the transcript pi reports. Asking now means the owner
  // opening the Brain lane finds this process rather than starting a second one on the file.
  await client.request({ type: 'get_state' })
  opened(client.sessionFile ?? sessionPath)
  deps.changed(deps.folder)
  return { sessionId: live.sessionId, client }
}

export function createBrainAgentLane(deps: BrainLaneDeps): BrainAgentHost {
  return {
    folder: deps.folder,
    async turn(message, signal, hooks) {
      let before: string | null = null
      let lane: OpenLane | undefined
      let end: TurnEnd
      try {
        // Written only while missing, so the rules the owner keeps stay as they are.
        await ensureBrainLane(deps.folder)
        before = await readBrainRules(deps.folder)
        lane = await open(deps, hooks.opened)
        end = await prompt(deps, lane, message, signal, hooks.sending)
      } catch (error) {
        end = signal.aborted
          ? { outcome: 'stopped', error: null }
          : { outcome: 'failed', error: text(error) }
      }
      deps.changed(deps.folder)
      return {
        ...end,
        sessionPath: lane?.client.sessionFile ?? null,
        rulesChanged: (await readBrainRules(deps.folder)) !== before,
      }
    },
  }
}
