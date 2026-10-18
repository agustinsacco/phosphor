import { titleCandidates, type NamingOutcome } from './naming'
import type { HostRuntime } from '../session/runtime'
import { piState } from './pi-results'
import type { LaneSessions } from './create'
import { promptTitle } from './live'
import type { RuntimeLaneOptions, RuntimeLaneState } from './runtime-host/state'
import {
  guardModelChange,
  replaceProviderProcess,
  finishModelSelection,
} from './runtime-host/model-switch'
import * as lifecycle from './runtime-host/lifecycle'

export function createRuntimeLanes(options: RuntimeLaneOptions) {
  const { runtime, live } = options
  const context: RuntimeLaneState = { options, bindings: new Map() }
  const { bindings } = context
  const start = lifecycle.start.bind(null, context)
  const attach = lifecycle.attach.bind(null, context)
  const stop = lifecycle.stop.bind(null, context)
  const sessions: LaneSessions = { start, attach, stop }
  return {
    sessions,
    resumeLane: lifecycle.resumeLane.bind(null, context),
    deleteStop: lifecycle.deleteStop.bind(null, context),
    stopLane: lifecycle.stopLane.bind(null, context),
    async command(...args: Parameters<HostRuntime['command']>) {
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
        if (response.success && args[1].type === 'prompt' && binding?.laneId) {
          const laneId = binding.laneId
          const lane = options.store.getLane(laneId)
          const fallback = promptTitle(args[1].message)
          if (lane && lane.removedAt === null && !lane.title && fallback)
            options.store.updateLane(laneId, { title: fallback })
          live.firstPrompt(laneId, args[1].message)
          if (options.nameLane && !binding.namingConsidered) {
            binding.namingConsidered = true
            const started = Date.now()
            let reported = false
            const outcome = (outcome: NamingOutcome) => {
              if (reported) return
              reported = true
              try {
                options.log('host', 'lane.naming', { laneId, outcome, ms: Date.now() - started })
              } catch {
                /* Diagnostics cannot fail a prompt. */
              }
            }
            if (!binding.namingEligible) {
              outcome('skipped-not-eligible')
              return response
            }
            binding.namingEligible = false
            const nameLane = options.nameLane
            const message = args[1].message
            const revision = binding.renameRevision
            const current = () =>
              bindings.get(args[0]) === binding &&
              live.sessionFor(laneId) === args[0] &&
              options.store.getLane(laneId)?.removedAt === null &&
              binding.renameRevision === revision
            void (async () => {
              const stateResponse = await runtime.command(args[0], { type: 'get_state' })
              const state = stateResponse.success ? piState(stateResponse.data) : null
              const modelsResponse = await runtime.command(args[0], {
                type: 'get_available_models',
              })
              if (!current()) return outcome('stale')
              if (!state?.model) return outcome('skipped-no-model')
              if (state.sessionName) return outcome('skipped-not-eligible')
              nameLane({
                outcome,
                cwd: options.store.getLane(laneId)?.cwd ?? '',
                message,
                model: state.model,
                models:
                  modelsResponse.type === 'response' &&
                  modelsResponse.command === 'get_available_models' &&
                  modelsResponse.success
                    ? titleCandidates(modelsResponse.data)
                    : [],
                current,
                async apply(title) {
                  if (!current()) return 'stale'
                  const latestResponse = await runtime.command(args[0], { type: 'get_state' })
                  const latest = latestResponse.success ? piState(latestResponse.data) : null
                  if (!current() || latest?.sessionName) return 'stale'
                  if (!latest) return 'set-failed'
                  const named = await runtime.command(args[0], {
                    type: 'set_session_name',
                    name: title,
                  })
                  if (named.success) {
                    options.store.updateLane(laneId, { title })
                    binding.attachment?.stateChanged()
                    return 'applied'
                  }
                  return 'set-failed'
                },
              })
            })().catch(() => outcome('set-failed'))
          }
        }
        if (response.success && args[1].type === 'set_session_name' && binding?.laneId) {
          const lane = options.store.getLane(binding.laneId)
          if (lane?.removedAt === null)
            options.store.updateLane(binding.laneId, { title: args[1].name })
        }
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
    },
    extensionUiResponse: runtime.extensionUiResponse,
  }
}
