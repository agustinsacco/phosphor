import { tidyApi } from './tidy/api'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  checkBrainReaderModel,
  brainNeverReadReason,
  checkBrainNeverRead,
  setBrainLaneNeverRead,
  type BrainLaneRef,
  type BrainPrefs,
  type BrainStatus,
} from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { BrainApi, BrainServiceOptions, BrainSearchPort } from './types'
import type { ExtractionQueue } from './queue'
import { extractionView } from './extraction-view'
import { laneInfo } from './lane'
import type { LaneFiles } from './lane-files'
import type { TidyMaintenance } from './tidy/maintenance'
import { BRAIN_OWN_LANE_REFUSAL, isBrainOwnLane } from './agent/own-lane'
import type { Defrag } from './agent/defrag'
import { defragApi } from './agent/defrag-api'

interface ApiContext {
  store: BrainStore
  options: BrainServiceOptions
  search: BrainSearchPort
  queue: ExtractionQueue
  files: LaneFiles
  changed(): void
  startModel(run: () => Promise<void>): void
  maintenance: Pick<TidyMaintenance, 'reset'>
  defrag: Defrag
}
function checkPrefs(prefs: BrainPrefs): void {
  if (
    !prefs ||
    Object.keys(prefs).sort().join() !== 'agentAuto,enabled,model,neverRead,recall' ||
    ['enabled', 'recall', 'agentAuto'].some(
      (k) => typeof prefs[k as keyof BrainPrefs] !== 'boolean',
    )
  )
    throw new Error('Invalid Brain preferences.')
  checkBrainReaderModel(prefs.model)
  checkBrainNeverRead(prefs.neverRead)
}
async function enqueue(
  ref: BrainLaneRef,
  { store, options, queue, files }: ApiContext,
  replaces?: string,
): Promise<void> {
  const check = () => {
    if (!queue.accepting) throw new Error('Brain is resetting.')
    if (!store.snapshot().prefs.enabled) throw new Error('Turn on Brain before queueing a lane.')
  }
  check()
  const lane = await files
    .read(ref.sessionPath)
    .then((entries) => laneInfo(entries, store.snapshot().prefs.model))
    .catch((error: unknown) => {
      if (replaces && (error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error("This lane's file is gone, so Brain cannot read it again.")
      throw error
    })
  check()
  if (isBrainOwnLane(lane.cwd, options.agent?.folder)) throw new Error(BRAIN_OWN_LANE_REFUSAL)
  const refusal = brainNeverReadReason(store.snapshot().prefs.neverRead, {
    sessionId: lane.sessionId,
    title: lane.title ?? '',
  })
  if (refusal) throw new Error(refusal)
  store.enqueue(
    {
      replaces,
      sessionPath: ref.sessionPath,
      title: lane.title ?? '',
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
  if (!previous || !['done', 'empty', 'rejected'].includes(previous.state))
    throw new Error('Only finished Brain reads can be read again.')
  if (
    store
      .snapshot()
      .jobs.some(
        (j) =>
          j.sessionId === previous.sessionId && ['waiting', 'queued', 'running'].includes(j.state),
      )
  )
    throw new Error('This lane is already queued.')
  await enqueue(previous, context, id)
}
export function createApi(context: ApiContext): BrainApi {
  const { store, options, search, queue, changed } = context
  const status = (): BrainStatus => apiStatus(context)
  const mutate = async (run: () => void): Promise<BrainStatus> => {
    run()
    await search.refresh()
    changed()
    queue.kick()
    return status()
  }

  return {
    status: async () => status(),
    laneRead: async (id) => store.laneRead(id),
    setOwner: (id) => mutate(() => store.setOwner(id)),
    tell: async (message) => {
      if (!store.snapshot().prefs.enabled) throw new Error('Turn on Brain to message Brain Agent.')
      if (!options.agent) throw new Error('Brain Agent runs on Desktop.')
      return options.agent.tell(message)
    },
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
    ...tidyApi(store, status, mutate),
    ...defragApi(store, context.defrag, status, mutate),
    ...readApi(context),
    forget: async (id) => mutate(() => store.forget(id)),
  }
}

function modelApi(
  context: ApiContext,
  status: () => BrainStatus,
): Pick<BrainApi, 'setPrefs' | 'neverRead' | 'download' | 'removeModel'> {
  const { store, options, changed, queue, startModel } = context
  return {
    neverRead: async (sessionId, never) => {
      store.setPrefs(setBrainLaneNeverRead(store.snapshot().prefs, sessionId, never))
      changed()
      queue.kick()
      return status()
    },
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
  'ask' | 'find' | 'overview' | 'neighbourhood' | 'entity' | 'entityMemories' | 'memory' | 'path'
> {
  return {
    ask: async (query) => {
      const rows = await options.embeddings.embed([query], 'query').catch(() => [])
      return search.recall({
        query,
        vector: rows[0] ? new Float32Array(rows[0]) : null,
        scope: null,
        branch: null,
        limit: 8,
        now: (options.now ?? Date.now)(),
      })
    },
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
    entityMemories: async (id, filter, cursor) => store.entityMemories(id, filter, cursor),
    memory: async (id) => store.memory(id),
    path: async (from, to) => search.routes(from, to, (options.now ?? Date.now)()),
  }
}

function apiStatus({ store, options }: ApiContext): BrainStatus {
  const embedding = options.embeddings.status()
  return {
    ...store.snapshot(),
    tidy: store.tidySummary(),
    agent: {
      waiting: store.waitingCounts(),
      run: store.latestRun(),
      folder: options.agent?.folder ?? null,
    },
    supported: embedding.phase !== 'unsupported',
    embedding,
  }
}
