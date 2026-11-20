import { brainNeverReadReason, type BrainJob } from '@phosphor/shared/brain'
import {
  BRAIN_POSSIBLE_REPEATS_PER_RUN,
  type BrainAgentMap,
  type BrainWaitingItem,
} from '@phosphor/shared/brain-agent'
import type { BrainStore } from '@phosphor/memory-engine/types'
import { formatReview } from '@phosphor/brain-client/curator-review-format'
import { freshReview } from './review-refresh'
import { curatorWrites } from './curator-writes'
import {
  curatorEntity,
  curatorJob,
  curatorMemory,
  curatorRecall,
  curatorSuggestion,
  curatorTitle,
} from './curator-view'
import {
  BRAIN_OFF,
  refreshContext,
  waitingRead,
  type CuratorApi,
  type CuratorContext,
} from './curator-context'

const WAITING_LIMIT = 60
const byAge = (a: BrainJob, b: BrainJob): number =>
  (a.finishedAt ?? a.queuedAt) - (b.finishedAt ?? b.queuedAt) || a.queuedAt - b.queuedAt

function readItem(store: BrainStore, job: BrainJob): BrainWaitingItem {
  const proposal = store.storedProposal(job.id)
  const prefs = store.snapshot().prefs.neverRead
  return {
    kind: 'read',
    jobId: job.id,
    title: curatorTitle(job.title),
    state: job.state === 'refreshing' ? 'refreshing' : 'review',
    memories: proposal?.memories.length ?? job.memories,
    questions:
      (proposal?.entities.filter((entity) => entity.decision === 'uncertain').length ?? 0) +
      (proposal?.groups.length ?? 0),
    neverRead: brainNeverReadReason(prefs, job) !== null,
    finishedAt: job.finishedAt,
  }
}

function waiting(store: BrainStore, limit = WAITING_LIMIT): BrainAgentMap['waiting']['result'] {
  const reads = store
    .snapshot()
    .jobs.filter((job) => job.state === 'review' || job.state === 'refreshing')
    .sort(byAge)
  const shown = reads.slice(0, limit).map((job) => readItem(store, job))
  const rest = store.waitingSuggestions(limit - shown.length, BRAIN_POSSIBLE_REPEATS_PER_RUN)
  return {
    counts: store.waitingCounts(),
    items: [...shown, ...rest.items],
    more: reads.length - shown.length + rest.more,
  }
}
export function createCurator(context: CuratorContext): CuratorApi {
  const { store, search, options } = context
  const on = (): void => {
    if (!context.enabled()) throw new Error(BRAIN_OFF)
  }
  return {
    waiting: async (request) => {
      on()
      return waiting(store, request.limit)
    },
    // One page, formatted here: a long read is larger than a bridge frame.
    readReview: async ({ jobId, offset }, signal) => {
      on()
      const job = waitingRead(store, jobId)
      const refusal = await freshReview(refreshContext(context), jobId, signal)
      const current = store.job(jobId) ?? job
      const proposal = store.proposal(jobId)
      const review = {
        proposal: { ...proposal, job: curatorJob(proposal.job) },
        neverRead:
          refusal !== null ||
          brainNeverReadReason(store.snapshot().prefs.neverRead, current) !== null,
      }
      return { text: formatReview(review, offset) }
    },
    suggestion: async ({ suggestionId }) => {
      on()
      return curatorSuggestion(store.agentSuggestion(suggestionId))
    },
    entity: async ({ entityId }) => {
      on()
      return curatorEntity(store.entity(entityId))
    },
    memory: async ({ memoryId }) => {
      on()
      return curatorMemory(store.memory(memoryId))
    },
    search: async (request) => {
      on()
      const vector = await options.embeddings
        .embed([request.query], 'query')
        .then((rows) => (rows[0] ? new Float32Array(rows[0]) : null))
        .catch(() => null)
      // Brain Agent looks after every project alike: no lane cwd ranks one first.
      const recall = await search.recall({
        query: request.query,
        vector,
        scope: null,
        branch: null,
        now: (options.now ?? Date.now)(),
        limit: request.limit ?? 8,
      })
      return curatorRecall(recall)
    },
    ...curatorWrites(context),
  }
}
