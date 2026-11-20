import type { BrainJob, BrainLaneRef, BrainStatus } from '@shared/brain'
import { brainNeverReadReason } from '@shared/brain'
import { mockBrainJob } from './mockBrainData'
import type { MockReadHistory } from './mockReadHistory'
const UNFINISHED = ['waiting', 'queued', 'running', 'refreshing', 'review']

/** A whole-lane reread replaces; a later queue continues after the last finished leaf. */
export function queueMockBrain(
  lane: BrainLaneRef,
  previous: BrainJob | undefined,
  state: BrainStatus,
  history: MockReadHistory,
  now: () => number,
): void {
  if (!state.prefs.enabled) throw new Error('Turn Brain on first.')
  const earlier = history.jobs.find((job) => job.sessionPath === lane.sessionPath)
  const sessionId = previous?.sessionId ?? earlier?.sessionId ?? lane.sessionPath
  const refusal = brainNeverReadReason(state.prefs.neverRead, {
    sessionId,
    title: lane.title,
  })
  if (refusal) throw new Error(refusal)
  if (
    state.jobs.some((job) => job.sessionPath === lane.sessionPath && UNFINISHED.includes(job.state))
  )
    throw new Error('This lane is already queued.')
  const id = crypto.randomUUID()
  state.jobs.push(
    mockBrainJob({
      id,
      sessionPath: lane.sessionPath,
      title: lane.title,
      replaces: previous?.id ?? null,
      sessionId,
      state: 'queued',
      memories: 0,
      leafId: `leaf-${id}`,
      fromLeafId: previous ? null : (earlier?.leafId ?? null),
      queuedAt: now(),
      startedAt: null,
      finishedAt: null,
    }),
  )
}
