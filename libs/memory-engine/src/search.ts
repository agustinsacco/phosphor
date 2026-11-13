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
class SearchIndexes {
  entities: VectorIndex
  memories: VectorIndex
  loaded = false
  private closed = false
  private generation: string | undefined
  private revision: string | undefined
  private pending: Promise<void> | null = null
  constructor(private ctx: Context) {
    this.entities = new VectorIndex(ctx, 'entity')
    this.memories = new VectorIndex(ctx, 'memory')
  }
  private meta(): Record<string, string> {
    return Object.fromEntries(
      all<{ key: string; value: string }>(
        this.ctx,
        "SELECT key,value FROM meta WHERE key IN ('generation','revision')",
      ).map((row) => [row.key, row.value]),
    )
  }
  refresh(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Brain search is closed.'))
    if (!this.pending)
      this.pending = this.load().finally(() => {
        this.pending = null
      })
    return this.pending
  }
  private async load(): Promise<void> {
    // Coalesce concurrent refreshes, including one catch-up pass for commits made during loading.
    let passes = 0
    while (!this.closed && passes < 2) {
      const meta = this.meta()
      if (this.loaded && this.generation === meta.generation && this.revision === meta.revision)
        return
      const rebuild = this.generation !== meta.generation
      if (rebuild) this.loaded = false
      const current = (): boolean => {
        if (this.closed) return false
        if (this.meta().generation === meta.generation) return true
        this.loaded = false
        return false
      }
      const entities = await this.entities.refresh(rebuild || this.entities.stale(), current)
      if (!entities) continue
      const memories = await this.memories.refresh(rebuild || this.memories.stale(), current)
      if (!memories || !current()) continue
      this.entities = entities
      this.memories = memories
      this.generation = meta.generation
      this.revision = meta.revision
      this.loaded = true
      passes++
    }
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.loaded = false
    this.ctx.db.close()
  }
}
export function openBrainSearch(options: Pick<OpenStoreOptions, 'path' | 'Database'>): BrainSearch {
  const ctx: Context = {
    db: new options.Database(options.path, { readOnly: true, timeout: 2000 }),
    now: Date.now,
    id: randomUUID,
  }
  const indexes = new SearchIndexes(ctx)
  const degradation = () =>
    indexes.loaded ? [] : ['Semantic index loading; words and names only.']
  return {
    refresh: () => indexes.refresh(),
    ready: () => indexes.loaded,
    nearestEntities: (vectors, k) =>
      vectors.map((vector) => (indexes.loaded ? indexes.entities.nearest(vector, k) : [])),
    nearestMemories: (vectors, k) =>
      vectors.map((vector) => (indexes.loaded ? indexes.memories.nearest(vector, k) : [])),
    recall: (input) =>
      recall(
        ctx,
        input,
        {
          entities:
            indexes.loaded && input.vector ? indexes.entities.nearest(input.vector, 20) : [],
          memories:
            indexes.loaded && input.vector ? indexes.memories.nearest(input.vector, 50) : [],
        },
        degradation(),
      ),
    find: (query, vector, limit) =>
      find(
        ctx,
        query,
        indexes.loaded ? vector : null,
        limit,
        indexes.entities,
        indexes.memories,
        degradation(),
      ),
    close: () => indexes.close(),
  }
}
