import type { RpcCommand } from '@phosphor/shared/rpc'
import { attach, hasSavedSession, learnFile, persistModel, start, stop } from './lifecycle'
import { MODEL_TRANSCRIPT_REFUSAL, type Binding, type RuntimeLaneState } from './state'

type ModelCommand = Extract<RpcCommand, { type: 'set_model' }>

function refusal(error: string) {
  return {
    type: 'response' as const,
    command: 'set_model' as const,
    success: false as const,
    error,
  }
}

export async function guardModelChange(
  context: RuntimeLaneState,
  sessionId: string,
  binding: Binding | undefined,
  command: ModelCommand,
) {
  const beforeModel = binding?.laneId ? await learnFile(context, binding.laneId, sessionId) : null
  if (beforeModel && (beforeModel.isStreaming || beforeModel.isCompacting))
    return { beforeModel, refusal: refusal('Wait for the current turn before changing providers.') }
  if (beforeModel?.model && beforeModel.model.provider !== command.provider) {
    if (command.provider.length > 64 || command.modelId.length > 128)
      return { beforeModel, refusal: refusal("This model can't be used on a Host lane.") }
    try {
      // An unreadable or non-regular transcript leaves the original process untouched.
      await hasSavedSession(beforeModel.sessionFile)
    } catch {
      return { beforeModel, refusal: refusal(MODEL_TRANSCRIPT_REFUSAL) }
    }
  }
  return { beforeModel }
}

export async function verifySelectedModel(
  context: RuntimeLaneState,
  sessionId: string,
  binding: Binding,
  laneId: string,
) {
  const { options, bindings } = context
  const selected = await learnFile(context, laneId, sessionId)
  if (!selected?.model) throw new Error('Model change could not be verified.')
  const lane = options.store.getLane(laneId)
  if (!lane || lane.removedAt !== null) throw new Error('Lane unavailable.')
  if (bindings.get(sessionId) !== binding || options.live.sessionFor(laneId) !== sessionId)
    throw new Error('Lane unavailable.')
  let persisted: boolean
  try {
    // set_model may queue behind the first prompt: use pi's fresh file identity.
    persisted = await hasSavedSession(selected.sessionFile)
  } catch {
    await binding.attachment?.stateChanged()
    return {
      refusal: refusal(
        'The lane transcript could not be verified. Check the lane before retrying.',
      ),
    }
  }
  return { selected, model: selected.model, lane, persisted }
}

export async function restoreUnsavedName(
  context: RuntimeLaneState,
  sessionId: string,
  name: string | undefined,
  persisted: boolean,
) {
  if (!persisted && name) {
    const named = await context.options.runtime.command(sessionId, {
      type: 'set_session_name',
      name,
    })
    if (!named.success) throw new Error('Lane name could not be restored.')
  }
}

export async function replaceProviderProcess(
  context: RuntimeLaneState,
  sessionId: string,
  binding: Binding,
  laneId: string,
) {
  const verified = await verifySelectedModel(context, sessionId, binding, laneId)
  if (verified.refusal) return verified.refusal
  const { selected, model, lane, persisted } = verified
  const { options, bindings } = context
  // Stop/delete may have removed this incarnation while the stat awaited.
  const current = options.store.getLane(laneId)
  if (
    !current ||
    current.removedAt !== null ||
    bindings.get(sessionId) !== binding ||
    options.live.sessionFor(laneId) !== sessionId
  )
    throw new Error('Lane unavailable.')
  persistModel(context, laneId, model)
  await stop(context, sessionId)
  const resumed = await start(context, {
    repository: lane.cwd,
    ...(persisted ? { sessionPath: selected.sessionFile } : {}),
    provider: model.provider,
    model: model.id,
    thinkingLevel: selected.thinkingLevel,
  })
  try {
    // The replacement's get_state supplies its identity, not the old allocated path.
    if (resumed.sessionFile) context.options.store.bindSessionFile(laneId, resumed.sessionFile)
    if (!persisted && selected.sessionName)
      await restoreUnsavedName(context, resumed.sessionId, selected.sessionName, persisted)
    await attach(context, laneId, resumed.sessionId)
  } catch (error) {
    await stop(context, resumed.sessionId)
    throw error
  }
}

export async function finishModelSelection(
  context: RuntimeLaneState,
  sessionId: string,
  binding: Binding | undefined,
) {
  const currentId = binding?.laneId ? context.options.live.sessionFor(binding.laneId) : sessionId
  if (currentId) {
    if (binding?.laneId) {
      const selected = await learnFile(context, binding.laneId, currentId)
      if (selected?.model) persistModel(context, binding.laneId, selected.model)
    }
    await context.bindings.get(currentId)?.attachment?.stateChanged()
  }
}
