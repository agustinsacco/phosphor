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
import type { BrainAgentHost, BrainAgentTurn } from '@phosphor/brain-runtime/types'
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
 * Resolves once the lane has no turn, compaction or queued message; rejects when it closes or
 * `signal` aborts. A turn the owner started is theirs to finish: waiting never aborts it.
 */
async function settled({ client }: OpenLane, signal: AbortSignal): Promise<void> {
  const state = await client.request({ type: 'get_state' })
  if (!state.success || !state.data) throw new Error('Brain Agent’s lane did not answer.')
  const { isStreaming, isCompacting, pendingMessageCount } = state.data
  if (!isStreaming && !isCompacting && pendingMessageCount === 0) return
  await new Promise<void>((resolve, reject) => {
    const done = (end: () => void) => {
      client.off('event', onEvent)
      client.off('exit', onExit)
      signal.removeEventListener('abort', onAbort)
      end()
    }
    const onEvent = (event: PiEvent) => {
      if (event.type === 'agent_settled') done(resolve)
    }
    const onExit = () => done(() => reject(new Error(BRAIN_LANE_CLOSED)))
    const onAbort = () => done(() => reject(new Error('stopped')))
    client.on('event', onEvent)
    client.on('exit', onExit)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
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

/** Sends the message and resolves when its turn ends, stops or fails. */
function prompt(
  deps: BrainLaneDeps,
  { sessionId, client }: OpenLane,
  message: string,
  signal: AbortSignal,
): Promise<TurnEnd> {
  return new Promise((resolve) => {
    let ended = false
    const finish = (outcome: TurnEnd['outcome'], error: string | null = null) => {
      if (ended) return
      ended = true
      client.off('event', onEvent)
      client.off('exit', onExit)
      signal.removeEventListener('abort', onAbort)
      resolve({ outcome, error })
    }
    const onEvent = (event: PiEvent) => {
      if (event.type === 'agent_end' && !event.willRetry) {
        const end = runEnd(event.messages)
        finish(end.outcome, end.error)
      }
      if (event.type === 'extension_error') finish('failed', `Extension error: ${event.error}`)
    }
    const onExit = () => finish('failed', BRAIN_LANE_CLOSED)
    const onAbort = () => {
      void deps.command(sessionId, { type: 'abort' }).catch(() => undefined)
      finish('stopped')
    }
    client.on('event', onEvent)
    client.on('exit', onExit)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) return onAbort()
    if (!client.alive) return onExit()
    deps.command(sessionId, { type: 'prompt', message }).then(
      (response) => {
        if (!response.success) finish('failed', response.error ?? 'pi refused the message.')
      },
      (error: unknown) => finish('failed', text(error)),
    )
  })
}

/** Resumes the newest transcript or starts the lane, and learns its transcript at once. */
async function open(
  deps: BrainLaneDeps,
  started: (sessionPath: string | null) => void,
): Promise<OpenLane> {
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
  started(client.sessionFile ?? sessionPath)
  deps.changed(deps.folder)
  return { sessionId: live.sessionId, client }
}

export function createBrainAgentLane(deps: BrainLaneDeps): BrainAgentHost {
  return {
    folder: deps.folder,
    async turn(message, signal, started) {
      let before: string | null = null
      let lane: OpenLane | undefined
      let end: TurnEnd
      try {
        // Written only while missing, so the rules the owner keeps stay as they are.
        await ensureBrainLane(deps.folder)
        before = await readBrainRules(deps.folder)
        lane = await open(deps, started)
        await settled(lane, signal)
        end = await prompt(deps, lane, message, signal)
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
