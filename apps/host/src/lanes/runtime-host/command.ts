import type { HostRuntime } from '../../session/runtime'
import type { RuntimeLaneState } from './state'
import { firstPrompt, recordManualName } from './naming'
import { guardModelChange, replaceProviderProcess, finishModelSelection } from './model-switch'

export async function command(
  context: RuntimeLaneState,
  ...args: Parameters<HostRuntime['command']>
) {
  const { options, bindings } = context
  const { runtime, live } = options
  const binding = bindings.get(args[0])
  if (binding?.switching)
    return {
      type: 'response' as const,
      command: args[1].type,
      success: false as const,
      error: 'Wait for the model change to finish.',
    }
  const modelChange = args[1].type === 'set_model'
  if (modelChange && binding) binding.switching = true
  try {
    if (args[1].type === 'set_session_name' && binding) {
      binding.renameRevision = (binding.renameRevision ?? 0) + 1
      binding.namingEligible = false
    }
    const guarded =
      args[1].type === 'set_model'
        ? await guardModelChange(context, args[0], binding, args[1])
        : { beforeModel: null }
    if (guarded.refusal) return guarded.refusal
    const { beforeModel } = guarded
    const response = await runtime.command(...args)
    if (
      response.success &&
      args[1].type === 'set_model' &&
      binding?.laneId &&
      beforeModel?.model &&
      beforeModel.model.provider !== args[1].provider
    ) {
      const refusal = await replaceProviderProcess(context, args[0], binding, binding.laneId)
      if (refusal) return refusal
    }
    if (response.success && args[1].type === 'prompt' && binding?.laneId)
      firstPrompt(context, args[0], binding, binding.laneId, args[1].message)
    if (response.success && args[1].type === 'set_session_name' && binding)
      recordManualName(context, binding, args[1].name)
    if (
      response.success &&
      ['set_model', 'set_thinking_level', 'set_session_name'].includes(args[1].type)
    ) {
      if (args[1].type === 'set_model') await finishModelSelection(context, args[0], binding)
      else {
        const currentId = binding?.laneId ? live.sessionFor(binding.laneId) : args[0]
        if (currentId) await bindings.get(currentId)?.attachment?.stateChanged()
      }
    }
    return response
  } finally {
    if (modelChange && binding) binding.switching = false
  }
}
