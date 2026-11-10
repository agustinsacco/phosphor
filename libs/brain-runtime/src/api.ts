import type { BrainLaneRef, BrainPrefs, BrainStatus } from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { BrainApi, BrainServiceOptions } from './types'
import type { ExtractionQueue } from './queue'
import { extractionView } from './extraction-view'
import { readLane } from './lane'

interface ApiContext {
  store: BrainStore
  options: BrainServiceOptions
  queue: ExtractionQueue
  changed(): void
  startModel(run: () => Promise<void>): void
}
function checkPrefs(prefs: BrainPrefs): void {
  if (
    !prefs ||
    ['enabled', 'recall', 'review'].some(
      (key) => typeof prefs[key as keyof BrainPrefs] !== 'boolean',
    )
  )
    throw new Error('Invalid Brain preferences.')
}
async function enqueue(ref: BrainLaneRef, { store, options }: ApiContext): Promise<void> {
  if (!store.snapshot().prefs.enabled) throw new Error('Turn on Brain before queueing a lane.')
  const lane = await readLane(ref.sessionPath)
  // Preferences may change while the session and its git metadata are loading.
  if (!store.snapshot().prefs.enabled) throw new Error('Turn on Brain before queueing a lane.')
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
  const { store, options, queue, changed, startModel } = context
  const status = (): BrainStatus => {
    const embedding = options.embeddings.status()
    return { ...store.snapshot(), supported: embedding.phase !== 'unsupported', embedding }
  }
  const mutate = (run: () => void): BrainStatus => {
    run()
    changed()
    queue.kick()
    return status()
  }
  return {
    status: async () => status(),
    setPrefs: async (prefs) => {
      checkPrefs(prefs)
      const previous = store.snapshot().prefs
      store.setPrefs(prefs)
      if (previous.enabled !== prefs.enabled)
        startModel(() => options.embeddings.setEnabled(prefs.enabled))
      return mutate(() => undefined)
    },
    download: async () => {
      startModel(() => options.embeddings.download())
      return status()
    },
    removeModel: async () => {
      if (store.snapshot().prefs.enabled)
        throw new Error('Turn off Brain before removing its model.')
      await options.embeddings.remove()
      return mutate(() => undefined)
    },
    queue: async (ref) => {
      await enqueue(ref, context)
      return mutate(() => undefined)
    },
    cancel: async (id) => {
      queue.cancel(id)
      return status()
    },
    extraction: async (id) => extractionView(store, id),
    proposal: async (id) => store.proposal(id),
    review: async (id, keep, revision) => mutate(() => store.review(id, keep, revision)),
    knowledge: async () => store.knowledge(),
    memory: async (id) => store.memory(id),
    forget: async (id) => mutate(() => store.forget(id)),
  }
}
