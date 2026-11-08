import type { BrainServiceOptions, BrainApi } from './service-types'
import type { BrainMemoryClient } from './memory-client'
import type { BrainStatus } from '@phosphor/shared/brain'
import type { createBrainIndexer } from './indexer'
import type { createBrainProcessor } from './processor'
import type { createBrainLearning } from './learning-coordinator'
import type { createBrainTranscripts } from './transcripts'
import { bounded, brainQuery, canonicalPrefs, identifier, laneAuthority } from './authority'

interface Controller {
  options: BrainServiceOptions
  store: BrainMemoryClient
  indexer: ReturnType<typeof createBrainIndexer>
  processor: ReturnType<typeof createBrainProcessor>
  learning?: ReturnType<typeof createBrainLearning>
  transcripts: ReturnType<typeof createBrainTranscripts>
  serialize<T>(operation: () => Promise<T>): Promise<T>
  status(): Promise<BrainStatus>
  revoke(): Promise<void>
  isClosed(): boolean
}
/** Derived indexing cannot turn a committed edit into a reported write failure. */
async function indexDerived({ indexer, options }: Controller): Promise<void> {
  try {
    await indexer.index()
  } catch (error) {
    options.onError?.(error)
  }
}
function learningApi({
  store,
  learning,
  processor,
  serialize,
}: Controller): Pick<
  BrainApi,
  'learnPreview' | 'learn' | 'learningJobs' | 'learningDetail' | 'cancel'
> {
  const learner = () => {
    if (!learning) throw new Error('Selective learning requires a qualified local pi binding')
    return learning
  }
  return {
    learnPreview: (target) => serialize(() => learner().preview(bounded(target))),
    learn: (target, consent) => serialize(() => learner().start(bounded(target), bounded(consent))),
    learningJobs: async (scope) => {
      const list = await store.learningJobs(scope === undefined ? undefined : bounded(scope))
      const snapshot = await store.snapshot()
      return {
        ...list,
        policy: {
          enabled: snapshot.prefs.enabled,
          workspaces: snapshot.prefs.workspaces,
          policyEpoch: snapshot.policyEpoch,
        },
      }
    },
    learningDetail: (id) => store.learningDetail(identifier(id)),
    cancel: (id) =>
      serialize(async () => {
        const job = await store.job(identifier(id))
        if (job.learning) await learner().cancel(id)
        else await processor.cancel(id)
      }),
  }
}
export function createBrainApi(controller: Controller): BrainApi {
  const { options, store, indexer, processor, transcripts, serialize, status, revoke, isClosed } =
    controller
  const index = () => indexDerived(controller)
  const api: BrainApi = {
    ...learningApi(controller),
    status,
    setPrefs: (prefs) =>
      serialize(async () => {
        bounded(prefs)
        const canonical = await canonicalPrefs(prefs)
        await revoke()
        const snapshot = await store.setPrefs(canonical)
        await options.embeddings.setEnabled(snapshot.prefs.enabled)
      }).then(async () => {
        await index()
        return status()
      }),
    download: async (acceptTerms) => {
      if (isClosed() || acceptTerms !== true)
        throw new Error('Explicit model terms acknowledgement required')
      await options.embeddings.download(true)
      await index()
      return status()
    },
    removeModel: async () => {
      if (isClosed()) throw new Error('Brain is disposed')
      await options.embeddings.remove()
      return status()
    },
    search: async (query) => {
      brainQuery(query)
      const snapshot = await store.snapshot()
      const scopes = query.scopes ?? snapshot.prefs.workspaces
      if (
        !Array.isArray(scopes) ||
        scopes.some((scope) => !snapshot.prefs.workspaces.includes(scope))
      )
        throw new Error('Brain search scope unavailable')
      return indexer.search(query, scopes)
    },
    read: async (id) => store.read(identifier(id), (await store.snapshot()).prefs.workspaces),
    evidence: (scope, cursor) =>
      store.evidencePage(bounded(scope), cursor === undefined ? undefined : identifier(cursor)),
    graph: (id) => store.graph(id === undefined ? undefined : identifier(id)),
    process: (scope, consent) =>
      serialize(async () => {
        bounded(consent)
        const canonical = (await laneAuthority(scope)).scope
        return processor.process(canonical, consent)
      }),

    review: (id, approve, revision) =>
      serialize(async () => {
        if (typeof approve !== 'boolean') throw new Error('Invalid Brain review')
        await store.review(identifier(id), approve, bounded(revision))
      }).then(index),
    correct: (id, correction, revision) =>
      serialize(async () => {
        await store.correct(identifier(id), bounded(correction), bounded(revision))
      }).then(index),
    forget: (ids) =>
      serialize(async () => {
        if (!Array.isArray(ids) || ids.length > 500)
          throw new Error('Invalid Brain forget selection')
        await revoke()
        const result = await store.forget(ids.map(identifier))
        await transcripts.purge()
        return result
      }).then(async (result) => {
        await index()
        return result
      }),
    transcript: (id) => transcripts.read(identifier(id)),
  }
  return api
}
