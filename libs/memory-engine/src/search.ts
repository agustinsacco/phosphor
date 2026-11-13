import { randomUUID } from 'node:crypto'
import type { BrainFindResult } from '@phosphor/shared/brain'
import { all, type Context } from './database'
import { entity, referencedEntities } from './entities'
import { memoryCards } from './knowledge'
import { recall } from './recall'
import { entitySeeds, lexicalIds } from './seeds'
import { VectorIndex } from './vector-index'
import type { BrainSearch, OpenStoreOptions } from './types'

function find(
  ctx: Context,
  query: string,
  vector: Float32Array | null,
  limit: number,
  entitiesIndex: VectorIndex,
  memoriesIndex: VectorIndex,
  degradation: string[],
): BrainFindResult {
  const cap = Math.min(50, Math.max(0, limit))
  if (!query.trim()) return { entities: [], memories: [], referenced: [], degradation }
  const entityIds = [
    ...new Set([
      ...entitySeeds(ctx, query, cap),
      ...(vector
        ? entitiesIndex
            .nearest(vector, cap)
            .filter((item) => item.score >= 0.35)
            .map((item) => item.id)
        : []),
    ]),
  ].slice(0, cap)
  const memoryIds = [
    ...new Set([
      ...lexicalIds(ctx, query, cap),
      ...(vector
        ? memoriesIndex
            .nearest(vector, cap)
            .filter((item) => item.score >= 0.35)
            .map((item) => item.id)
        : []),
    ]),
  ].slice(0, cap)
  const memories = memoryCards(ctx, memoryIds)
  return {
    entities: entityIds.map((id) => entity(ctx, id)!).filter(Boolean),
    memories,
    referenced: referencedEntities(ctx, memories).filter((item) => !entityIds.includes(item.id)),
    degradation,
  }
}
export function openBrainSearch(options: Pick<OpenStoreOptions, 'path' | 'Database'>): BrainSearch {
  const ctx: Context = {
    db: new options.Database(options.path, { readOnly: true, timeout: 2000 }),
    now: Date.now,
    id: randomUUID,
  }
  const entities = new VectorIndex(ctx, 'entity')
  const memories = new VectorIndex(ctx, 'memory')
  let loaded = false
  let generation: string | undefined
  let revision: string | undefined
  const degradation = () => (loaded ? [] : ['Semantic index loading; words and names only.'])
  return {
    refresh: () => {
      const meta = Object.fromEntries(
        all<{ key: string; value: string }>(
          ctx,
          "SELECT key,value FROM meta WHERE key IN ('generation','revision')",
        ).map((row) => [row.key, row.value]),
      )
      if (loaded && generation === meta.generation && revision === meta.revision) return
      const rebuild = generation !== meta.generation
      entities.refresh(rebuild || entities.stale())
      memories.refresh(rebuild || memories.stale())
      generation = meta.generation
      revision = meta.revision
      loaded = true
    },
    ready: () => loaded,
    nearestEntities: (vectors, k) =>
      vectors.map((vector) => (loaded ? entities.nearest(vector, k) : [])),
    nearestMemories: (vectors, k) =>
      vectors.map((vector) => (loaded ? memories.nearest(vector, k) : [])),
    recall: (input) =>
      recall(
        ctx,
        input,
        {
          entities: loaded && input.vector ? entities.nearest(input.vector, 20) : [],
          memories: loaded && input.vector ? memories.nearest(input.vector, 50) : [],
        },
        degradation(),
      ),
    find: (query, vector, limit) =>
      find(ctx, query, loaded ? vector : null, limit, entities, memories, degradation()),
    close: () => ctx.db.close(),
  }
}
