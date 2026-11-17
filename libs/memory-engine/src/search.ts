import { entities, recent } from './browse'
import { randomUUID } from 'node:crypto'
import type { BrainFindResult } from '@phosphor/shared/brain'
import { all, type Context } from './database'
import { entity, referencedEntities } from './entities'
import { NEAREST, rank, recall, type Nearest } from './recall'
import { entitySeeds } from './seeds'
import { VectorIndex } from './vector-index'
import type { BrainSearch, OpenStoreOptions } from './types'

/**
 * The Brain page's search. Memories are the top of the ranking `brain_search` uses, read for an
 * agent with no project; people and things matched by name or alias come first, then nearby ones.
 */
function find(
  ctx: Context,
  query: string,
  vector: Float32Array | null,
  limit: number,
  nearest: Nearest,
  degradation: string[],
): BrainFindResult {
  const cap = Math.min(50, Math.max(0, limit))
  if (!query.trim() || !cap) return { entities: [], memories: [], referenced: [], degradation }
  const input = { query, vector, limit: cap, scope: null, branch: null, now: ctx.now() }
  const memories = rank(ctx, input, nearest)
    .hits.slice(0, cap)
    .map((hit) => hit.memory)
  const entityIds = [
    ...new Set([
      ...entitySeeds(ctx, query, cap),
      ...nearest.entities.filter((item) => item.score >= 0.35).map((item) => item.id),
    ]),
  ].slice(0, cap)
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
  private vectorEpoch: string | undefined
  private pending: Promise<void> | null = null
  private again = false
  constructor(private ctx: Context) {
    this.entities = new VectorIndex(ctx, 'entity')
    this.memories = new VectorIndex(ctx, 'memory')
  }
  private meta(): Record<string, string> {
    return Object.fromEntries(
      all<{ key: string; value: string }>(
        this.ctx,
        "SELECT key,value FROM meta WHERE key IN ('generation','revision','vector_epoch')",
      ).map((row) => [row.key, row.value]),
    )
  }
  refresh(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Brain search is closed.'))
    if (this.pending) {
      // A caller that joins mid-load may have committed after this load read the revision.
      this.again = true
      return this.pending
    }
    this.pending = this.run().finally(() => {
      this.pending = null
    })
    return this.pending
  }
  private async run(): Promise<void> {
    do {
      this.again = false
      await this.load()
    } while (this.again && !this.closed)
  }
  private async load(): Promise<void> {
    // Coalesce concurrent refreshes, including one catch-up pass for commits made during loading.
    let passes = 0
    while (!this.closed && passes < 2) {
      const meta = this.meta()
      if (this.loaded && this.generation === meta.generation && this.revision === meta.revision)
        return
      const rebuild = this.generation !== meta.generation || this.vectorEpoch !== meta.vector_epoch
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
      this.vectorEpoch = meta.vector_epoch
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
  const nearest = (vector: Float32Array | null): Nearest => ({
    entities: indexes.loaded && vector ? indexes.entities.nearest(vector, NEAREST.entities) : [],
    memories: indexes.loaded && vector ? indexes.memories.nearest(vector, NEAREST.memories) : [],
  })
  return {
    refresh: () => indexes.refresh(),
    ready: () => indexes.loaded,
    entities: (kind, offset, limit, sort) => entities(ctx, kind, offset, limit, sort),
    recent: (limit) => recent(ctx, limit),
    nearestEntities: (vectors, k) =>
      vectors.map((vector) => (indexes.loaded ? indexes.entities.nearest(vector, k) : [])),
    nearestMemories: (vectors, k) =>
      vectors.map((vector) => (indexes.loaded ? indexes.memories.nearest(vector, k) : [])),
    recall: (input) => recall(ctx, input, nearest(input.vector), degradation()),
    find: (query, vector, limit) =>
      find(ctx, query, indexes.loaded ? vector : null, limit, nearest(vector), degradation()),
    close: () => indexes.close(),
  }
}
