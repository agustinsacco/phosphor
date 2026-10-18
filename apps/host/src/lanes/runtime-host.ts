import { lstat } from 'node:fs/promises'
import { titleCandidates, type createLaneNamer, type NamingOutcome } from './naming'
import type { SessionPush } from '@phosphor/shared/models'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import type { HostRuntime } from '../session/runtime'
import { piState } from './pi-results'
import type { LaneSessions } from './create'
import { promptTitle, type createLiveLanes } from './live'
import type { HostStore, StoredLane } from './store'

const STARTUP_PUSHES = 256
const STARTUP_BYTES = 1024 * 1024
const MODEL_TRANSCRIPT_REFUSAL = 'The lane transcript could not be verified. Model was not changed.'
type Binding = {
  switching?: boolean
  namingEligible?: boolean
  namingConsidered?: boolean
  renameRevision?: number
  laneId?: string
  pushes: SessionPush[]
  bytes: number
  overflow: boolean
  attachment?: ReturnType<ReturnType<typeof createLiveLanes>['attach']>
}

export function createRuntimeLanes(options: {
  runtime: Pick<HostRuntime, 'start' | 'stop' | 'command' | 'extensionUiResponse'>
  store: Pick<HostStore, 'getLane' | 'updateLane' | 'bindSessionFile'>
  live: ReturnType<typeof createLiveLanes>
  nameLane?: (...args: Parameters<ReturnType<typeof createLaneNamer>>) => void
  log: RuntimeLog
}) {
  const { runtime, live } = options
  const bindings = new Map<string, Binding>()
  async function start(request: unknown) {
    const binding: Binding = { pushes: [], bytes: 0, overflow: false }
    const session = await runtime.start(request, (push) => {
      if (push.kind === 'stderr') return
      if (binding.laneId !== undefined) return live.push(binding.laneId, push)
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
    })
    bindings.set(session.sessionId, binding)
    try {
      const state = await runtime.command(session.sessionId, { type: 'get_state' })
      const data = state.success ? piState(state.data) : null
      if (!data) throw new Error('the lane could not start')
      return {
        sessionId: session.sessionId,
        sessionFile: typeof data.sessionFile === 'string' ? data.sessionFile : null,
      }
    } catch (error) {
      await stop(session.sessionId)
      throw error
    }
  }
  async function attach(laneId: string, sessionId: string) {
    const binding = bindings.get(sessionId)
    if (!binding || !options.store.getLane(laneId)) throw new Error('unknown lane start')
    // An unexpected exit keeps its failed projection until an explicit resume.
    for (const [id, previous] of bindings)
      if (id !== sessionId && previous.laneId === laneId) bindings.delete(id)
    live.detach(laneId)
    binding.attachment = live.attach(laneId, sessionId)
    binding.laneId = laneId
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
    await binding.attachment.ready
    if (options.nameLane) {
      const response = await runtime.command(sessionId, { type: 'get_state' })
      const state = response.success ? piState(response.data) : null
      binding.namingEligible = state?.messageCount === 0 && !state.sessionName
    }
  }
  async function stop(sessionId: string) {
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
  async function learnFile(laneId: string, sessionId: string) {
    const response = await runtime.command(sessionId, { type: 'get_state' })
    const state = response.success ? piState(response.data) : null
    if (state?.sessionFile) options.store.bindSessionFile(laneId, state.sessionFile)
    return state
  }
  function persistModel(laneId: string, model: { provider: string; id: string }) {
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
  async function hasSavedSession(file: string | undefined): Promise<boolean> {
    if (!file) return false
    try {
      const info = await lstat(file)
      if (info.isFile()) return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return false
    }
    throw new Error(MODEL_TRANSCRIPT_REFUSAL)
  }
  const sessions: LaneSessions = { start, attach, stop }
  return {
    sessions,
    async resumeLane(lane: StoredLane) {
      if (lane.sessionFile === null) throw new Error('the lane could not start')
      // The runtime parser requires the recorded file to still exist.
      const session = await start({ repository: lane.cwd, sessionPath: lane.sessionFile })
      try {
        await attach(lane.laneId, session.sessionId)
      } catch (error) {
        await stop(session.sessionId)
        throw error
      }
    },
    async deleteStop(laneId: string, allowed: () => boolean = () => true) {
      const sessionId = live.sessionFor(laneId)
      if (sessionId !== null) {
        const state = await learnFile(laneId, sessionId)
        if (!state || (!state.sessionFile && (state.messageCount > 0 || state.isStreaming)))
          throw new Error('Lane file identity could not be verified.')
        if (!allowed()) throw new Error('Lane control changed.')
        await stop(sessionId)
      }
    },
    async stopLane(laneId: string, authorized: () => boolean = () => true) {
      const sessionId = live.sessionFor(laneId)
      if (sessionId !== null) {
        const state = await learnFile(laneId, sessionId)
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
        await stop(sessionId)
      }
    },
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
        const beforeModel =
          args[1].type === 'set_model' && binding?.laneId
            ? await learnFile(binding.laneId, args[0])
            : null
        if (beforeModel && (beforeModel.isStreaming || beforeModel.isCompacting))
          return {
            type: 'response' as const,
            command: args[1].type,
            success: false as const,
            error: 'Wait for the current turn before changing providers.',
          }
        if (
          args[1].type === 'set_model' &&
          beforeModel?.model &&
          beforeModel.model.provider !== args[1].provider
        ) {
          if (args[1].provider.length > 64 || args[1].modelId.length > 128)
            return {
              type: 'response' as const,
              command: args[1].type,
              success: false as const,
              error: "This model can't be used on a Host lane.",
            }
          try {
            // Check before asking pi to switch: an unreadable or non-regular
            // transcript must leave the original process and model untouched.
            await hasSavedSession(beforeModel.sessionFile)
          } catch {
            return {
              type: 'response' as const,
              command: args[1].type,
              success: false as const,
              error: MODEL_TRANSCRIPT_REFUSAL,
            }
          }
        }
        const response = await runtime.command(...args)
        if (
          response.success &&
          args[1].type === 'set_model' &&
          binding?.laneId &&
          beforeModel?.model &&
          beforeModel.model.provider !== args[1].provider
        ) {
          const laneId = binding.laneId
          const selected = await learnFile(laneId, args[0])
          if (!selected?.model) throw new Error('Model change could not be verified.')
          const lane = options.store.getLane(laneId)
          if (!lane || lane.removedAt !== null) throw new Error('Lane unavailable.')
          if (bindings.get(args[0]) !== binding || live.sessionFor(laneId) !== args[0])
            throw new Error('Lane unavailable.')
          let persisted: boolean
          try {
            // set_model can wait behind an admitted first prompt. Decide from
            // pi's fresh file identity and presence, not the early pre-check.
            persisted = await hasSavedSession(selected.sessionFile)
          } catch {
            await binding.attachment?.stateChanged()
            return {
              type: 'response' as const,
              command: args[1].type,
              success: false as const,
              error: 'The lane transcript could not be verified. Check the lane before retrying.',
            }
          }
          // A Stop or delete can run while the transcript check awaits; it removes
          // the binding and stops pi. Proceeding would resurrect a stopped lane.
          const current = options.store.getLane(laneId)
          if (
            !current ||
            current.removedAt !== null ||
            bindings.get(args[0]) !== binding ||
            live.sessionFor(laneId) !== args[0]
          )
            throw new Error('Lane unavailable.')
          persistModel(laneId, selected.model)
          await stop(args[0])
          const resumed = await start({
            repository: lane.cwd,
            ...(persisted ? { sessionPath: selected.sessionFile } : {}),
            provider: selected.model.provider,
            model: selected.model.id,
            thinkingLevel: selected.thinkingLevel,
          })
          try {
            // start learned this identity from the replacement pi's get_state;
            // the old unprompted process's allocated path is no longer valid.
            if (resumed.sessionFile) options.store.bindSessionFile(laneId, resumed.sessionFile)
            if (!persisted && selected.sessionName) {
              const named = await runtime.command(resumed.sessionId, {
                type: 'set_session_name',
                name: selected.sessionName,
              })
              if (!named.success) throw new Error('Lane name could not be restored.')
            }
            await attach(laneId, resumed.sessionId)
          } catch (error) {
            await stop(resumed.sessionId)
            throw error
          }
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
          const currentId = binding?.laneId ? live.sessionFor(binding.laneId) : args[0]
          if (currentId) {
            if (args[1].type === 'set_model' && binding?.laneId) {
              const selected = await learnFile(binding.laneId, currentId)
              if (selected?.model) persistModel(binding.laneId, selected.model)
            }
            await bindings.get(currentId)?.attachment?.stateChanged()
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
