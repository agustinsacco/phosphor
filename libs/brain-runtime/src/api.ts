import { createTidyRunner, type TidyRunner } from './tidy/run'
import { tidyApi } from './tidy/api'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  checkBrainReaderModel,
  type BrainLaneRef,
  type BrainPrefs,
  type BrainStatus,
} from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { BrainApi, BrainServiceOptions, BrainSearchPort } from './types'
import type { ExtractionQueue } from './queue'
import { extractionView } from './extraction-view'
import { readLane } from './lane'
import type { TidyMaintenance } from './tidy/maintenance'

interface ApiContext {
  store: BrainStore
  options: BrainServiceOptions
  search: BrainSearchPort
  queue: ExtractionQueue
  changed(): void
  startModel(run: () => Promise<void>): void
  maintenance: Pick<TidyMaintenance, 'reset'>
}
function checkPrefs(prefs: BrainPrefs): void {
  if (
    !prefs ||
    ['enabled', 'recall', 'review'].some((k) => typeof prefs[k as keyof BrainPrefs] !== 'boolean')
  )
    throw new Error('Invalid Brain preferences.')
  checkBrainReaderModel(prefs.model)
}
async function enqueue(
  ref: BrainLaneRef,
  { store, options, queue }: ApiContext,
  replaces?: string,
): Promise<void> {
  const check = () => {
    if (!queue.accepting) throw new Error('Brain is resetting.')
    if (!store.snapshot().prefs.enabled) throw new Error('Turn on Brain before queueing a lane.')
  }
  check()
  const lane = await readLane(ref.sessionPath, store.snapshot().prefs.model).catch(
    (error: unknown) => {
      if (replaces && (error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error("This lane's file is gone, so Brain cannot read it again.")
      throw error
    },
  )
  check()
  store.enqueue(
    {
      replaces,
      sessionPath: ref.sessionPath,
      title: ref.title,
      sessionId: lane.sessionId,
      scope: lane.scope,
      branch: lane.branch,
      model: lane.model,
      leafId: lane.leafId,
    },
    options.lanes.busy(ref.sessionPath) ? 'waiting' : 'queued',
  )
}
async function reread(id: string, context: ApiContext): Promise<void> {
  const { store } = context
  const previous = store.job(id)
  if (previous?.state !== 'done') throw new Error('Only finished Brain reads can be read again.')
  if (
    store
      .snapshot()
      .jobs.some(
        (j) =>
          j.sessionId === previous.sessionId &&
          ['waiting', 'queued', 'running', 'review'].includes(j.state),
      )
  )
    throw new Error('This lane is already queued.')
  await enqueue(previous, context, id)
}
export function createApi(context: ApiContext): BrainApi {
  const { store, options, search, queue, changed } = context
  const tidy = createTidyRunner({ ...context, runState: store })
  const status = (): BrainStatus => apiStatus(context, tidy)
  const mutate = async (run: () => void): Promise<BrainStatus> => {
    run()
    await search.refresh()
    changed()
    queue.kick()
    return status()
  }
  const current = (id: string): void => {
    const proposal = store.storedProposal(id)
    if (proposal && proposal.computedRevision !== store.revision()) {
      queue.recompute(id)
      throw new Error('Brain changed; refreshing this review')
    }
  }
  return {
    status: async () => status(),
    history: async (limit) => store.history(limit),
    reread: async (id) => {
      await reread(id, context)
      changed()
      queue.kick()
      return status()
    },
    ...modelApi(context, status),
    queue: async (ref) => {
      await enqueue(ref, context)
      changed()
      queue.kick()
      return status()
    },
    cancel: async (id) => {
      queue.cancel(id)
      return status()
    },
    retry: async (id) => {
      queue.retry(id)
      return status()
    },
    extraction: async (id) => extractionView(store, id),
    proposal: async (id) => {
      current(id)
      return store.proposal(id)
    },
    review: async (id, decision, revision) => {
      current(id)
      return mutate(() => store.review(id, decision, revision))
    },
    reset: async () => {
      await queue.pause()
      try {
        context.maintenance.reset()
        store.reset()
        await Promise.all(
          ['calls', 'forks'].map((name) =>
            rm(join(options.directory, name), { recursive: true, force: true }),
          ),
        )
        await search.refresh()
        changed()
        return status()
      } finally {
        queue.resume()
      }
    },
    ...tidyApi(context, tidy, status, mutate),
    ...readApi(context),
    forget: async (id) => mutate(() => store.forget(id)),
  }
}

function modelApi(
  context: ApiContext,
  status: () => BrainStatus,
): Pick<BrainApi, 'setPrefs' | 'download' | 'removeModel'> {
  const { store, options, changed, queue, startModel } = context
  return {
    setPrefs: async (prefs) => {
      checkPrefs(prefs)
      const previous = store.snapshot().prefs
      store.setPrefs(prefs)
      if (previous.enabled !== prefs.enabled)
        startModel(() => options.embeddings.setEnabled(prefs.enabled))
      changed()
      queue.kick()
      return status()
    },
    download: async () => {
      startModel(() => options.embeddings.download())
      return status()
    },
    removeModel: async () => {
      if (store.snapshot().prefs.enabled)
        throw new Error('Turn off Brain before removing its model.')
      await options.embeddings.remove()
      changed()
      return status()
    },
  }
}

function readApi({
  store,
  options,
  search,
}: ApiContext): Pick<
  BrainApi,
  | 'entities'
  | 'recent'
  | 'find'
  | 'overview'
  | 'neighbourhood'
  | 'entity'
  | 'connections'
  | 'entityMemories'
  | 'memory'
  | 'path'
> {
  return {
    entities: (kind, offset, limit) => search.entities(kind, offset, limit),
    recent: (limit) => search.recent(limit),
    find: async (query, limit) => {
      const rows = await options.embeddings.embed([query], 'query').catch(() => [])
      return search.find(
        query,
        rows[0] ? new Float32Array(rows[0]) : null,
        Math.max(1, Math.min(50, limit)),
      )
    },
    overview: async () => store.overview(300),
    neighbourhood: async (id, hops) => store.neighbourhood(id, hops, 300),
    entity: async (id) => store.entity(id),
    connections: async (id, predicate, direction, cursor) =>
      store.connections(id, predicate, direction, cursor),
    entityMemories: async (id, filter, cursor) => store.entityMemories(id, filter, cursor),
    memory: async (id) => store.memory(id),
    path: async (from, to) => store.path(from, to),
  }
}

function apiStatus({ store, options }: ApiContext, tidy: TidyRunner): BrainStatus {
  const embedding = options.embeddings.status()
  return {
    ...store.snapshot(),
    tidy: {
      ...store.tidySummary(),
      running: ['queued', 'sweeping', 'checking'].includes(tidy.current()?.state ?? ''),
    },
    supported: embedding.phase !== 'unsupported',
    embedding,
  }
}
