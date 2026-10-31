import { lstat } from 'node:fs/promises'
import type { SessionPush } from '@phosphor/shared/models'
import { errnoIs } from '../../fs-safety'
import { piState } from '../pi-results'
import type { StoredLane } from '../store'
import { runEnded, syncBranch } from './branch'
import { MODEL_TRANSCRIPT_REFUSAL, type Binding, type RuntimeLaneState } from './state'

const STARTUP_PUSHES = 256
const STARTUP_BYTES = 1024 * 1024

export async function start(context: RuntimeLaneState, request: unknown) {
  const { options, bindings } = context
  const { runtime } = options
  const binding: Binding = { pushes: [], bytes: 0, overflow: false }
  const session = await runtime.start(request, (push) => bufferPush(context, binding, push))
  bindings.set(session.sessionId, binding)
  try {
    const state = await runtime.command(session.sessionId, { type: 'get_state' })
    const data = state.success ? piState(state.data) : null
    // The token code is what the Host log records; the message stays fixed.
    if (!data)
      throw Object.assign(new Error('the lane could not start'), {
        code: state.success ? 'pi-state-unreadable' : 'pi-state-failed',
      })
    return {
      sessionId: session.sessionId,
      sessionFile: typeof data.sessionFile === 'string' ? data.sessionFile : null,
    }
  } catch (error) {
    await stop(context, session.sessionId)
    throw error
  }
}
export async function attach(context: RuntimeLaneState, laneId: string, sessionId: string) {
  const { options, bindings } = context
  const { runtime, live } = options
  const binding = bindings.get(sessionId)
  if (!binding || !options.store.getLane(laneId)) throw new Error('unknown lane start')
  // An unexpected exit keeps its failed projection until an explicit resume.
  for (const [id, previous] of bindings)
    if (id !== sessionId && previous.laneId === laneId) bindings.delete(id)
  live.detach(laneId)
  binding.attachment = live.attach(laneId, sessionId)
  binding.laneId = laneId
  replayStartup(context, binding, laneId)
  await binding.attachment.ready
  await syncBranch(context, binding)
  if (options.nameLane) {
    const response = await runtime.command(sessionId, { type: 'get_state' })
    const state = response.success ? piState(response.data) : null
    binding.namingEligible = state?.messageCount === 0 && !state.sessionName
  }
}
export async function stop(context: RuntimeLaneState, sessionId: string) {
  const { options, bindings } = context
  const { runtime, live } = options
  const binding = bindings.get(sessionId)
  // Failed creations must discard their startup pushes even if stopping fails.
  bindings.delete(sessionId)
  binding?.pushes.splice(0)
  const laneId = binding?.laneId
  try {
    await runtime.stop(sessionId)
  } finally {
    if (binding) binding.laneId = undefined
    if (laneId !== undefined) live.detach(laneId)
  }
}
export async function learnFile(context: RuntimeLaneState, laneId: string, sessionId: string) {
  const { options } = context
  const { runtime } = options
  const response = await runtime.command(sessionId, { type: 'get_state' })
  const state = response.success ? piState(response.data) : null
  if (state?.sessionFile) options.store.bindSessionFile(laneId, state.sessionFile)
  return state
}
export function persistModel(
  context: RuntimeLaneState,
  laneId: string,
  model: { provider: string; id: string },
) {
  const { options } = context
  try {
    options.store.updateLane(laneId, { provider: model.provider, model: model.id })
  } catch {
    // pi has already switched. A summary write must not turn its success into
    // an uncertain command outcome, even if logging is also unavailable.
    try {
      options.log('host', 'lane.model_persistence_failed')
    } catch {
      // Logging cannot fail a confirmed model selection.
    }
  }
}
export async function hasSavedSession(file: string | undefined): Promise<boolean> {
  if (!file) return false
  try {
    const info = await lstat(file)
    if (info.isFile()) return true
  } catch (error) {
    if (errnoIs(error, 'ENOENT', 'ENOTDIR')) return false
  }
  throw new Error(MODEL_TRANSCRIPT_REFUSAL)
}
export async function resumeLane(context: RuntimeLaneState, lane: StoredLane) {
  if (lane.sessionFile === null) throw new Error('the lane could not start')
  // pi cannot run without its folder. Say so, rather than fail as an unknown start.
  const folder = await lstat(lane.cwd).then(
    (info) => info.isDirectory(),
    (error: unknown) => (errnoIs(error, 'ENOENT', 'ENOTDIR') ? false : true),
  )
  if (!folder)
    throw Object.assign(new Error('the lane folder is missing'), { code: 'lane-folder-missing' })
  // The runtime parser requires the recorded file to still exist.
  const session = await start(context, { repository: lane.cwd, sessionPath: lane.sessionFile })
  try {
    await attach(context, lane.laneId, session.sessionId)
  } catch (error) {
    await stop(context, session.sessionId)
    throw error
  }
}

export async function deleteStop(
  context: RuntimeLaneState,
  laneId: string,
  allowed: () => boolean = () => true,
) {
  const { live } = context.options
  const sessionId = live.sessionFor(laneId)
  if (sessionId !== null) {
    const state = await learnFile(context, laneId, sessionId)
    if (!state || (!state.sessionFile && (state.messageCount > 0 || state.isStreaming)))
      throw new Error('Lane file identity could not be verified.')
    if (!allowed()) throw new Error('Lane control changed.')
    await stop(context, sessionId)
  }
}

export async function stopLane(
  context: RuntimeLaneState,
  laneId: string,
  authorized: () => boolean = () => true,
) {
  const { live } = context.options
  const sessionId = live.sessionFor(laneId)
  if (sessionId !== null) {
    const state = await learnFile(context, laneId, sessionId)
    // pi reports its session path before the file exists; it writes the file when a
    // turn ends. Stopping before then leaves nothing to resume, so require the file.
    const persisted =
      !!state?.sessionFile &&
      (await lstat(state.sessionFile).then(
        (info) => info.isFile(),
        () => false,
      ))
    if (!persisted)
      throw Object.assign(new Error('Send a first message before stopping this lane.'), {
        code: 'first-prompt-required',
      })
    if (!authorized()) throw new Error('Lane control changed.')
    await stop(context, sessionId)
  }
}

function bufferPush(context: RuntimeLaneState, binding: Binding, push: SessionPush) {
  if (push.kind === 'stderr') return
  if (binding.laneId !== undefined) {
    context.options.live.push(binding.laneId, push)
    // syncBranch reports its own failures.
    if (runEnded(push)) void syncBranch(context, binding)
    return
  }
  if (binding.overflow) return
  const bytes = Buffer.byteLength(JSON.stringify(push))
  if (binding.pushes.length >= STARTUP_PUSHES || binding.bytes + bytes > STARTUP_BYTES) {
    binding.overflow = true
    binding.pushes = []
    binding.bytes = 0
  } else {
    binding.pushes.push(push)
    binding.bytes += bytes
  }
}
function replayStartup(context: RuntimeLaneState, binding: Binding, laneId: string) {
  const { options } = context
  const { live } = options
  if (binding.overflow) {
    try {
      options.log('host', 'lane.startup_overflow', { laneId })
    } catch {
      // Logging cannot fail an attachment.
    }
  }
  for (const push of binding.pushes) live.push(laneId, push)
  binding.pushes = []
  binding.bytes = 0
}
