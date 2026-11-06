import {
  BRAIN_EMBEDDING_MODEL,
  type BrainQuery,
  type BrainSearchResult,
} from '@phosphor/shared/brain'
import { brainQuery } from './authority'
import type { DesktopMemoryClient } from './memory-client'
import type { BrainEmbeddings } from './embedding-port'

/** Only reviewed summaries; completion is compared atomically with the pre-embedding revision. */
export function createBrainIndexer(store: DesktopMemoryClient, embeddings: BrainEmbeddings) {
  let stopped = false
  let running: Promise<void> | undefined
  let requested = false
  const abort = new AbortController()
  async function index(): Promise<void> {
    for (let batch = 0; batch < 25 && !stopped; batch++) {
      const revision = await store.snapshot()
      if (!revision.prefs.enabled || embeddings.status().phase !== 'ready') return
      const items = await store.embeddingItems(BRAIN_EMBEDDING_MODEL.id, 8)
      if (!items.length) return
      const vectors = await embeddings.embed(
        items.map((item) => item.text),
        'document',
        abort.signal,
      )
      if (stopped || vectors.length !== items.length) return
      if (
        !(await store.commitVectors(
          revision,
          items.map((item, index) => ({
            claimId: item.claimId,
            modelId: BRAIN_EMBEDDING_MODEL.id,
            values: vectors[index]!,
          })),
        ))
      )
        return
    }
  }
  async function drain(): Promise<void> {
    try {
      do {
        requested = false
        await index()
      } while (requested && !stopped)
    } finally {
      // Clear before settling the promise so a concurrent request cannot be lost.
      running = undefined
    }
  }
  return {
    index() {
      if (stopped) return Promise.resolve()
      requested = true
      running ??= drain()
      return running
    },
    search: (query: BrainQuery, scopes: string[]) =>
      searchBrain(store, embeddings, abort.signal, query, scopes),
    dispose() {
      stopped = true
      abort.abort()
    },
  }
}

async function searchBrain(
  store: DesktopMemoryClient,
  embeddings: BrainEmbeddings,
  signal: AbortSignal,
  query: BrainQuery,
  scopes: string[],
): Promise<BrainSearchResult> {
  brainQuery(query)
  const revision = await store.snapshot()
  let vector: { modelId: string; values: number[] } | undefined
  let degraded = false
  if (query.mode !== 'lexical') {
    try {
      const result = await embeddings.embed([query.query], 'query', signal)
      if (result.length !== 1 || !result[0]) throw new Error('Embedding query unavailable')
      vector = { modelId: BRAIN_EMBEDDING_MODEL.id, values: result[0] }
    } catch {
      degraded = true
    }
  }
  const result = await store.search(query, scopes, vector)
  if (
    result.policyEpoch !== revision.policyEpoch ||
    result.graphRevision !== revision.graphRevision
  )
    throw new Error('Brain changed during retrieval; retry')
  if (degraded) {
    result.degradation.push(
      'Local semantic retrieval unavailable; lexical and typed graph results only',
    )
    result.status = 'partial'
  }
  return result
}
