import { expand } from './expand'
import { routes } from './routes'
import { resolve } from './resolve'
import { RECALL_TUNING } from './recall-tuning'
export { RECALL_TUNING, rank } from './recall'
import { entities } from './browse'
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
  tuning: typeof RECALL_TUNING,
): BrainFindResult {
  const cap = Math.min(50, Math.max(0, limit))
  if (!query.trim() || !cap) return { entities: [], memories: [], referenced: [], degradation }
  const input = { query, vector, limit: cap, scope: null, branch: null, now: ctx.now() }
  const memories = rank(ctx, input, nearest, tuning)
    .hits.slice(0, cap)
    .map((hit) => hit.memory)
  const entityIds = [
    ...new Set([
      ...entitySeeds(ctx, query, cap),
      ...nearest.entities.filter((item) => item.score >= tuning.minCosine).map((item) => item.id),
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
/** One WAL snapshot per move, including its nearest-vector reads. Avoid taking the read lock
 * anew for each indexed probe, and never mix pre- and post-save rows in a trail. */
function readSnapshot<T>(ctx: Context, read: () => T): T {
  ctx.db.exec('BEGIN')
  try {
    const result = read()
    ctx.db.exec('COMMIT')
    return result
  } catch (error) {
    ctx.db.exec('ROLLBACK')
    throw error
  }
}
export function openBrainSearch(
  options: Pick<OpenStoreOptions, 'path' | 'Database'> & { tuning?: Partial<typeof RECALL_TUNING> },
): BrainSearch {
  const ctx: Context = {
    db: new options.Database(options.path, { readOnly: true, timeout: 2000 }),
    now: Date.now,
    id: randomUUID,
  }
  // Random vector and edge reads can use the OS page cache without copying each SQLite page.
  ctx.db.exec('PRAGMA mmap_size=536870912')
  const tuning = { ...RECALL_TUNING, ...options.tuning }
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
    expand: (input) => readSnapshot(ctx, () => expand(ctx, input, tuning)),
    resolve: (names) => readSnapshot(ctx, () => resolve(ctx, names)),
    routes: (from, to, now) => readSnapshot(ctx, () => routes(ctx, from, to, now)),
    nearestEntities: (vectors, k) =>
      vectors.map((vector) => (indexes.loaded ? indexes.entities.nearest(vector, k) : [])),
    nearestMemories: (vectors, k) =>
      vectors.map((vector) => (indexes.loaded ? indexes.memories.nearest(vector, k) : [])),
    recall: (input) =>
      readSnapshot(ctx, () => recall(ctx, input, nearest(input.vector), degradation(), tuning)),
    find: (query, vector, limit) =>
      readSnapshot(ctx, () =>
        find(
          ctx,
          query,
          indexes.loaded ? vector : null,
          limit,
          nearest(vector),
          degradation(),
          tuning,
        ),
      ),
    close: () => indexes.close(),
  }
}
