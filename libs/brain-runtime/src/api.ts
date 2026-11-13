import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrainLaneRef, BrainPrefs, BrainStatus } from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { BrainApi, BrainServiceOptions, BrainSearchPort } from './types'
import type { ExtractionQueue } from './queue'
import { extractionView } from './extraction-view'
import { readLane } from './lane'

interface ApiContext {
  store: BrainStore
  options: BrainServiceOptions
  search: BrainSearchPort
  queue: ExtractionQueue
  changed(): void
  startModel(run: () => Promise<void>): void
}
function checkPrefs(prefs: BrainPrefs): void {
  if (
    !prefs ||
    ['enabled', 'recall', 'review'].some((k) => typeof prefs[k as keyof BrainPrefs] !== 'boolean')
  )
    throw new Error('Invalid Brain preferences.')
}
async function enqueue(ref: BrainLaneRef, { store, options, queue }: ApiContext): Promise<void> {
  const check = () => {
    if (!queue.accepting) throw new Error('Brain is resetting.')
    if (!store.snapshot().prefs.enabled) throw new Error('Turn on Brain before queueing a lane.')
  }
  check()
  const lane = await readLane(ref.sessionPath)
  check()
  store.enqueue(
    {
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
export function createApi(context: ApiContext): BrainApi {
  const { store, options, search, queue, changed, startModel } = context
  const status = (): BrainStatus => {
    const embedding = options.embeddings.status()
    return { ...store.snapshot(), supported: embedding.phase !== 'unsupported', embedding }
  }
  const mutate = async (run: () => void): Promise<BrainStatus> => {
    run()
    await search.refresh()
    changed()
    queue.kick()
    return status()
  }
  const current = (id: string): void => {
    if (store.storedProposal(id)?.computedRevision !== store.revision()) {
      queue.recompute(id)
      throw new Error('Brain changed; refreshing this review')
    }
  }
  return {
    status: async () => status(),
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
    merge: async (source, target) => mutate(() => store.merge(source, target)),
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
    forget: async (id) => mutate(() => store.forget(id)),
  }
}
