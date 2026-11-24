import { brainTitleNeverRead, type BrainStatus, type BrainJob } from '@shared/brain'
import type { SessionMeta } from '@shared/models'
import { useBrain } from '@/features/brain/useBrain'
import { readLaneAgain } from '@/features/brain/readLaneAgain'
import { usePlatform } from '@/platform/Platform'
import type { LaneActionContext, LaneActionHandlers } from './laneActions'

const indexes = new WeakMap<
  BrainStatus,
  { read: Set<string>; excluded: Set<string>; active: Map<string, BrainJob> }
>()
function laneIndex(status: BrainStatus) {
  let index = indexes.get(status)
  if (!index) {
    index = {
      read: new Set(status.readSessionIds),
      excluded: new Set(status.prefs.neverRead.sessionIds),
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
  context: Pick<LaneActionContext, 'knowledge' | 'brainExclusion'>
  handlers: Pick<LaneActionHandlers, 'knowledge' | 'readAgain' | 'neverRead'>
} {
  const status = useBrain((s) => s.status)
  const localBrain = usePlatform().localBrain
  if (!localBrain || !status?.prefs.enabled || !meta.path || meta.cwd === status.agent.folder)
    return { context: {}, handlers: {} }
  const index = laneIndex(status)
  const job = index.active.get(meta.path)
  return {
    context: {
      knowledge: job ? 'cancel' : index.read.has(meta.sessionId) ? 'new' : 'queue',
      brainExclusion: brainTitleNeverRead(status.prefs.neverRead, title)
        ? 'title'
        : index.excluded.has(meta.sessionId)
          ? 'lane'
          : null,
    },
    handlers: {
      neverRead: () => {
        void useBrain.getState().neverRead(meta.sessionId, !index.excluded.has(meta.sessionId))
      },
      knowledge: () => {
        if (job) void useBrain.getState().cancel(job.id)
        else void useBrain.getState().queue({ sessionPath: meta.path, title })
      },
      readAgain: () => {
        void readLaneAgain(meta.sessionId)
      },
    },
  }
}
