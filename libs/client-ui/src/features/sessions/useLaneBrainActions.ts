import type { BrainStatus, BrainJob } from '@shared/brain'
import type { SessionMeta } from '@shared/models'
import { useBrain } from '@/features/brain/useBrain'
import { usePlatform } from '@/platform/Platform'
import type { LaneActionContext, LaneActionHandlers } from './laneActions'

const indexes = new WeakMap<BrainStatus, { read: Set<string>; active: Map<string, BrainJob> }>()
function laneIndex(status: BrainStatus) {
  let index = indexes.get(status)
  if (!index) {
    index = {
      read: new Set(status.readSessionIds),
      active: new Map(
        status.jobs
          .filter((j) => ['waiting', 'queued', 'running'].includes(j.state))
          .map((j) => [j.sessionPath, j]),
      ),
    }
    indexes.set(status, index)
  }
  return index
}

/** All rows share one index per bounded status snapshot; opening a menu never loads history. */
export function useLaneBrainActions(
  meta: SessionMeta,
  title: string,
): {
  context: Pick<LaneActionContext, 'knowledge'>
  handlers: Pick<LaneActionHandlers, 'knowledge'>
} {
  const status = useBrain((s) => s.status)
  const localBrain = usePlatform().localBrain
  if (!localBrain || !status?.prefs.enabled || !meta.path) return { context: {}, handlers: {} }
  const index = laneIndex(status)
  const job = index.active.get(meta.path)
  return {
    context: { knowledge: job ? 'cancel' : index.read.has(meta.sessionId) ? 'new' : 'queue' },
    handlers: {
      knowledge: () => {
        if (job) void useBrain.getState().cancel(job.id)
        else void useBrain.getState().queue({ sessionPath: meta.path, title })
      },
    },
  }
}
