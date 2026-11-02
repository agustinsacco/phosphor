import { titleCandidates, type NamingFailure, type NamingOutcome } from '../naming'
import { promptTitle } from '../live'
import { piState } from '../pi-results'
import type { Binding, RuntimeLaneOptions, RuntimeLaneState } from './state'

type NameLane = NonNullable<RuntimeLaneOptions['nameLane']>
type Outcome = (outcome: NamingOutcome, failure?: NamingFailure) => void

/** The prompt lists at most 40 existing names; the newest siblings matter most. */
const MAX_SIBLING_TITLES = 40

function reportOnce(context: RuntimeLaneState, laneId: string): Outcome {
  const started = Date.now()
  let reported = false
  return (outcome, failure) => {
    if (reported) return
    reported = true
    try {
      // Fixed tokens only: never the prompt, the title or the provider's output.
      const fields = { laneId, outcome, ...failure, ms: Date.now() - started }
      context.options.log('host', 'lane.naming', fields)
    } catch {
      /* Diagnostics cannot fail a prompt. */
    }
  }
}

export function firstPrompt(
  context: RuntimeLaneState,
  sessionId: string,
  binding: Binding,
  laneId: string,
  message: string,
) {
  const { options, bindings } = context
  const lane = options.store.getLane(laneId)
  const fallback = promptTitle(message)
  if (lane && lane.removedAt === null && !lane.title && fallback)
    options.store.updateLane(laneId, { title: fallback })
  options.live.firstPrompt(laneId, message)
  if (options.nameLane && !binding.namingConsidered) {
    binding.namingConsidered = true
    const outcome = reportOnce(context, laneId)
    if (options.nameLane.enabled?.() === false) {
      outcome('skipped-disabled')
      return
    }
    if (!binding.namingEligible) {
      outcome('skipped-not-eligible')
      return
    }
    binding.namingEligible = false
    const revision = binding.renameRevision
    const current = () =>
      bindings.get(sessionId) === binding &&
      options.live.sessionFor(laneId) === sessionId &&
      options.store.getLane(laneId)?.removedAt === null &&
      binding.renameRevision === revision
    void lookupNaming(
      context,
      sessionId,
      binding,
      laneId,
      message,
      options.nameLane,
      current,
      outcome,
    ).catch(() => outcome('set-failed'))
  }
}

async function lookupNaming(
  context: RuntimeLaneState,
  sessionId: string,
  binding: Binding,
  laneId: string,
  message: string,
  nameLane: NameLane,
  current: () => boolean,
  outcome: Outcome,
) {
  const { options } = context
  const { runtime } = options
  const stateResponse = await runtime.command(sessionId, { type: 'get_state' })
  const state = stateResponse.success ? piState(stateResponse.data) : null
  const modelsResponse = await runtime.command(sessionId, { type: 'get_available_models' })
  if (!current()) return outcome('stale')
  if (!state?.model) return outcome('skipped-no-model')
  if (state.sessionName) return outcome('skipped-not-eligible')
  nameLane({
    outcome,
    sessionId,
    cwd: options.store.getLane(laneId)?.cwd ?? '',
    message,
    existingNames: siblingTitles(context, laneId),
    model: state.model,
    models:
      modelsResponse.type === 'response' &&
      modelsResponse.command === 'get_available_models' &&
      modelsResponse.success
        ? titleCandidates(modelsResponse.data)
        : [],
    current,
    apply: (title) => applyGeneratedTitle(context, sessionId, binding, laneId, current, title),
  })
}

/** The titles of the repository's other lanes, newest first, as Desktop passes its repo's. */
function siblingTitles(context: RuntimeLaneState, laneId: string): string[] {
  const { store } = context.options
  const repositoryId = store.getLane(laneId)?.repositoryId
  return store
    .listLanes()
    .filter((lane) => lane.repositoryId === repositoryId && lane.laneId !== laneId)
    .flatMap((lane) => (lane.title ? [lane.title] : []))
    .reverse()
    .slice(0, MAX_SIBLING_TITLES)
}

export async function applyGeneratedTitle(
  context: RuntimeLaneState,
  sessionId: string,
  binding: Binding,
  laneId: string,
  current: () => boolean,
  title: string,
): Promise<'applied' | 'stale' | 'set-failed'> {
  const { options } = context
  const { runtime } = options
  if (!current()) return 'stale'
  const latestResponse = await runtime.command(sessionId, { type: 'get_state' })
  const latest = latestResponse.success ? piState(latestResponse.data) : null
  if (!current() || latest?.sessionName) return 'stale'
  if (!latest) return 'set-failed'
  const named = await runtime.command(sessionId, { type: 'set_session_name', name: title })
  if (named.success) {
    options.store.updateLane(laneId, { title })
    binding.attachment?.stateChanged()
    return 'applied'
  }
  return 'set-failed'
}

export function recordManualName(context: RuntimeLaneState, binding: Binding, name: string) {
  if (!binding.laneId) return
  const lane = context.options.store.getLane(binding.laneId)
  if (lane?.removedAt === null) context.options.store.updateLane(binding.laneId, { title: name })
}
