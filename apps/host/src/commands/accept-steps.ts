import { existsSync, readFileSync } from 'node:fs'
import { errorText } from '@phosphor/shared/errors'
import { ALL_THINKING_LEVELS } from '@phosphor/shared/thinking'
import type {
  AgentMessage,
  RpcCommand,
  RpcCommandType,
  RpcResponseDataMap,
} from '@phosphor/shared/rpc'
import { isGone } from '../session/lifecycle'
import {
  deadline,
  within,
  TimedOut,
  isBreakdownStatus,
  isTextDelta,
  send,
  type Deadline,
} from './accept-waits'
import type { AcceptLaneState } from './accept-lane'

export const CLAUDE_PROVIDER = 'pi-claude-cli'
/** The Host's own cleanup left a process group or a file behind, or did not end. */
export class CleanupFailed extends Error {}

const COUNT = 'Count from 1 to 2000, one number per line, with no other text.'
const RECALL =
  'Recall the PHX- token you replied with earlier in this session. ' +
  'Reply with exactly that token and nothing else.'

/** Send a command; pi must answer by `by`, which defaults to answerMs from now. */
export function call<K extends RpcCommandType>(
  state: AcceptLaneState,
  command: Extract<RpcCommand, { type: K }>,
  by: Deadline = deadline(state.timings.answerMs),
): Promise<RpcResponseDataMap[K]> {
  return send<K>(state.runtime, live(state).sessionId, command, by)
}
function live(state: AcceptLaneState) {
  if (!state.session) throw new Error('no session is running')
  return state.session
}
/** Prompt, and wait for the turn to end. A turn that failed says why. */
export async function turn(state: AcceptLaneState, message: string): Promise<string> {
  const { watch, timings } = state
  const ends = watch.count('agent_end')
  const by = deadline(timings.turnMs)
  await call(state, { type: 'prompt', message }, by)
  const end = await watch.until(() => watch.events('agent_end')[ends], by, 'agent_end')
  const last = end.messages.findLast((m: AgentMessage) => m.role === 'assistant')
  if (last && 'stopReason' in last && last.stopReason === 'error') {
    throw new Error(`the turn failed: ${('errorMessage' in last && last.errorMessage) || 'error'}`)
  }
  return (await call(state, { type: 'get_last_assistant_text' })).text ?? ''
}
async function startSession(state: AcceptLaneState, sessionPath?: string): Promise<void> {
  const { watch, timings, runtime, request } = state
  const mark = watch.mark()
  const by = deadline(timings.startMs)
  state.session = await within(
    runtime.start({ ...request, ...(sessionPath && { sessionPath }) }, watch.deliver),
    by,
    'answer to the start',
  )
  await watch.until(
    () => watch.since(mark).find(isBreakdownStatus),
    by,
    'phosphor-context-breakdown status',
  )
}
/** Stop a session, by stopMs: what the stop threw, or null. */
export const stopped = (state: AcceptLaneState, sessionId: string) =>
  within(state.runtime.stop(sessionId), deadline(state.timings.stopMs), 'end to the stop').then(
    () => null,
    (error: unknown) => error,
  )
/**
 * Stop the session: its process group must be gone once it has had time to
 * go. A group left behind, or a stop that does not end, is a cleanup
 * failure: pi's output can stay open after pi, held by a process that left
 * its group. A stop that failed with nothing left, as when pi had already
 * exited, fails the step only.
 */
export async function stop(state: AcceptLaneState): Promise<void> {
  const { result, settleMs } = state
  const { sessionId, pid } = live(state)
  state.session = null
  const failed = await stopped(state, sessionId)
  if (pid === undefined) throw new CleanupFailed('pi had no process id to check')
  const until = Date.now() + settleMs
  while (!isGone(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 20))
  result.groupsAlive = isGone(pid) ? 0 : 1
  const why = failed ? `: ${errorText(failed)}` : ''
  if (result.groupsAlive > 0) throw new CleanupFailed(`process group ${pid} is still there${why}`)
  if (failed instanceof TimedOut) {
    throw new CleanupFailed(`${failed.message}, though process group ${pid} is gone`)
  }
  if (failed) throw new Error(`the stop failed${why}`)
}

export async function startStep(state: AcceptLaneState): Promise<void> {
  const { result } = state
  await startSession(state)
  const { commands } = await call(state, { type: 'get_commands' })
  if (!commands.some((command) => command.name === 'phosphor-context-budget')) {
    throw new Error('get_commands does not list phosphor-context-budget')
  }
  result.extensionsLoaded = true
}

export async function stateStep(state: AcceptLaneState): Promise<void> {
  const { result, context } = state
  const lane = result.lane
  const current = await call(state, { type: 'get_state' })
  result.provider = current.model?.provider
  result.model = current.model?.id
  result.thinkingLevel = current.thinkingLevel
  result.transcript = current.sessionFile
  const provider = lane === 'claude' ? CLAUDE_PROVIDER : context.provider
  const native = lane === 'native' && result.provider && result.provider !== CLAUDE_PROVIDER
  if (provider ? result.provider !== provider : !native) {
    const asked = provider ? `, not ${provider}` : ''
    // pi ignores --provider without --model, and runs on its own default.
    const hint =
      lane === 'claude' && !context.claudeModel
        ? ": pi's default is not Claude, so name the lane's model with --claude-model"
        : ''
    throw new Error(`the ${lane} lane runs on provider ${result.provider ?? 'none'}${asked}${hint}`)
  }
  // Without --provider, a model named provider/id is read against pi's provider.
  const named = lane === 'claude' ? context.claudeModel : context.model
  const model = named && modelId(named, provider ?? result.provider)
  if (model && result.model !== model) {
    throw new Error(`the ${lane} lane runs model ${result.model ?? 'none'}, not ${model}`)
  }
  if (!current.sessionFile) throw new Error('pi names no session file')
}

export async function promptStep(state: AcceptLaneState): Promise<void> {
  const { token } = state
  const reply = await turn(state, `Reply with exactly this token and nothing else: ${token}`)
  if (!reply.includes(token)) throw new Error('the reply does not hold the token')
}

export async function abortStep(state: AcceptLaneState): Promise<void> {
  const { watch, timings } = state
  const ends = watch.count('agent_end')
  const mark = watch.mark()
  const counting = deadline(timings.turnMs)
  await call(state, { type: 'prompt', message: COUNT }, counting)
  await watch.until(() => watch.since(mark).find(isTextDelta), counting, 'text delta')
  // The abort's own answer counts toward its deadline.
  const aborting = deadline(timings.abortMs)
  await call(state, { type: 'abort' }, aborting)
  await watch.until(() => watch.events('agent_end')[ends], aborting, 'agent_end')
  if ((await call(state, { type: 'get_state' })).isStreaming)
    throw new Error('pi is still streaming')
}

export async function resumeStep(state: AcceptLaneState): Promise<void> {
  const { result, token } = state
  await startSession(state, result.transcript)
  const { messages } = await call(state, { type: 'get_messages' })
  const replies = messages.filter((m) => m.role === 'assistant')
  if (!replies.some((m) => JSON.stringify(m.content).includes(token))) {
    throw new Error('get_messages lacks the token reply')
  }
  if (!replies.some((m) => 'stopReason' in m && m.stopReason === 'aborted')) {
    throw new Error('get_messages lacks the aborted turn')
  }
  if (!(await turn(state, RECALL)).includes(token)) throw new Error('the recall lacks the token')
}

export async function closeStep(state: AcceptLaneState): Promise<void> {
  const { result, context, runtime } = state
  await stop(state)
  const file = result.transcript!
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, at) => {
      if (!line.trim()) return
      try {
        JSON.parse(line)
      } catch {
        throw new Error(`the transcript is not JSONL at line ${at + 1}`)
      }
    })
  if (context.keepTranscripts) return
  await runtime
    .remove({ repository: context.repository, sessionPath: file })
    .catch((error: unknown) => {
      throw new CleanupFailed(`the deletion failed: ${errorText(error)}`)
    })
  result.transcriptDeleted = !existsSync(file)
  if (!result.transcriptDeleted) throw new CleanupFailed('the transcript is still there')
}

/**
 * The model id a --model names. pi also takes `provider/id`, and a
 * `:level` thinking suffix; anything else must be pi's id exactly.
 */
function modelId(model: string, provider: string | undefined): string {
  const bare =
    provider && model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model
  const colon = bare.lastIndexOf(':')
  const suffix = bare.slice(colon + 1) as (typeof ALL_THINKING_LEVELS)[number]
  return colon > 0 && ALL_THINKING_LEVELS.includes(suffix) ? bare.slice(0, colon) : bare
}
