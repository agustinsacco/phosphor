import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { BrainTidyPair } from '@phosphor/shared/brain-tidy'
import type { BrainServiceOptions, ModelLaunch } from '../types'
import type { LaneMeta } from '../lane'
import { runModelCall } from '../model-call'
import type { CallTrace } from '../call-trace'
import { TIDY_SYSTEM, tidyPrompt } from './prompt'
import { parseTidy } from './parse'

export const NO_MODEL =
  'Brain has not finished reading a lane yet, so there is no model to check with.'
export async function tidyModel(store: BrainStore, options: BrainServiceOptions) {
  const pinned = store.snapshot().prefs.model
  for (const { job } of store.history(5).items) {
    try {
      const launch = await options.lanes.launch(job.sessionPath)
      const lane: LaneMeta = {
        sessionId: job.sessionId,
        cwd: job.scope,
        scope: job.scope,
        branch: job.branch,
        model: pinned ?? job.model,
        thinking: 'medium',
        leafId: job.leafId,
      }
      return { launch, lane }
    } catch {
      // A removed lane cannot supply its account; try the next finished read.
    }
  }
  return null
}

export function tidyCaller(
  options: BrainServiceOptions,
  model: { launch: ModelLaunch; lane: LaneMeta },
  signal: AbortSignal,
) {
  const job = { id: `tidy-${randomUUID()}` }
  let part = 0
  return async (loadPairs: () => BrainTidyPair[]) => {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      let reason: CallTrace['reason'] | undefined
      try {
        // Reload after every transport delay too; no erased card is retained for a retry.
        const pairs = loadPairs()
        if (!pairs.length) return { judgements: [], dropped: 0, missing: 0 }
        const result = await (options.runModelCall ?? runModelCall)({
          directory: options.directory,
          job,
          ...model,
          guardExtension: options.guardExtension,
          stage: 'tidy',
          part: ++part,
          systemPrompt: TIDY_SYSTEM,
          prompt: tidyPrompt(pairs),
          thinking: 'medium',
          signal,
          onTrace: (trace) => {
            reason = trace.reason
          },
        })
        signal.throwIfAborted()
        return parseTidy(result.text, pairs, model.lane.model)
      } catch (error) {
        if (
          signal.aborted ||
          attempt ||
          !['error', 'no-text', 'exit', 'spawn'].includes(reason ?? '')
        )
          throw error
        await (options.retryDelay ?? ((ms, signal) => delay(ms, undefined, { signal })))(
          2000,
          signal,
        )
      }
    }
  }
}
