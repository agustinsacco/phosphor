import { randomBytes } from 'node:crypto'
import { errorText } from '@phosphor/shared/errors'
import type { UnprovisionedClaudeStartupError } from '@phosphor/session-runtime/pi/session-account'
import type { HostRuntime } from '../session/runtime'
import type { HostSessionRequest } from '../session/request'
import type { AcceptContext, AcceptLane, AcceptLaneResult, AcceptTimings } from './accept'
import { watcher, TimedOut } from './accept-waits'
import {
  CLAUDE_PROVIDER,
  CleanupFailed,
  startStep,
  stateStep,
  promptStep,
  abortStep,
  stop,
  resumeStep,
  closeStep,
  stopped,
} from './accept-steps'

/** A step failed: its lane stops there, and the failure is in its steps. */
class StepFailed extends Error {}

export interface AcceptLaneState {
  runtime: Pick<HostRuntime, 'start' | 'command' | 'stop' | 'remove' | 'life'>
  context: AcceptContext
  result: AcceptLaneResult
  watch: ReturnType<typeof watcher>
  request: HostSessionRequest
  token: string
  session: { sessionId: string; pid?: number } | null
  startupAccountFailure?: UnprovisionedClaudeStartupError
  timings: AcceptTimings
  settleMs: number
  progress: (line: string) => void
}

export function createAcceptLaneState(
  runtime: AcceptLaneState['runtime'],
  lane: AcceptLane,
  context: AcceptContext,
  options: Pick<AcceptLaneState, 'timings' | 'settleMs' | 'progress'>,
): AcceptLaneState {
  return {
    runtime,
    context,
    ...options,
    result: {
      lane,
      verdict: 'fail',
      steps: [],
      extensionsLoaded: false,
      groupsAlive: 0,
      transcriptDeleted: false,
    },
    watch: watcher(),
    request: laneRequest(lane, context),
    token: `PHX-${randomBytes(4).toString('hex')}`,
    session: null,
  }
}

export async function runLane(
  runtime: AcceptLaneState['runtime'],
  lane: AcceptLane,
  context: AcceptContext,
  options: Pick<AcceptLaneState, 'timings' | 'settleMs' | 'progress'>,
): Promise<AcceptLaneResult> {
  const state = createAcceptLaneState(runtime, lane, context, options)
  try {
    await step(state, 'start', startStep)
    await step(state, 'state', stateStep)
    await step(state, 'prompt', promptStep)
    await step(state, 'abort', abortStep)
    await step(state, 'dispose', stop)
    await step(state, 'resume', resumeStep)
    await step(state, 'close', closeStep)
    state.result.verdict = 'pass'
  } catch (error) {
    if (!(error instanceof StepFailed)) throw error
  } finally {
    await cleanupLane(state)
  }
  return state.result
}

async function step(
  state: AcceptLaneState,
  name: string,
  run: (state: AcceptLaneState) => Promise<void>,
): Promise<void> {
  const { result, progress } = state
  const lane = result.lane
  const started = Date.now()
  try {
    await run(state)
  } catch (error) {
    const detail = errorText(error)
    const cleanup = error instanceof CleanupFailed
    result.steps.push({
      name,
      ok: false,
      ms: Date.now() - started,
      detail,
      ...(cleanup && { cleanup }),
    })
    progress(`${lane}: ${name} FAILED: ${detail}`)
    throw new StepFailed(detail)
  }
  result.steps.push({ name, ok: true, ms: Date.now() - started })
  progress(`${lane}: ${name} ok (${Date.now() - started} ms)`)
}

async function cleanupLane(state: AcceptLaneState): Promise<void> {
  const { session, runtime, result, progress } = state
  // A failed step can leave its session running. Its transcript is kept.
  if (session && !runtime.life.isDraining()) {
    const started = Date.now()
    const failed = await stopped(state, session.sessionId)
    // Any other failure is the drain's to find; one that never ends is not.
    if (failed instanceof TimedOut) {
      const detail = errorText(failed)
      result.steps.push({
        name: 'stop',
        ok: false,
        ms: Date.now() - started,
        detail,
        cleanup: true,
      })
      progress(`${result.lane}: stop FAILED: ${detail}`)
    }
  }
}

/** What a lane asks the runtime for: Claude through its provider, native on the defaults or as named. */
export function laneRequest(lane: AcceptLane, context: AcceptContext): HostSessionRequest {
  if (lane === 'claude') {
    return {
      repository: context.repository,
      ...(context.claudeModel !== undefined && {
        provider: CLAUDE_PROVIDER,
        model: context.claudeModel,
      }),
    }
  }
  return {
    repository: context.repository,
    ...(context.provider !== undefined && { provider: context.provider }),
    ...(context.model !== undefined && { model: context.model }),
  }
}
