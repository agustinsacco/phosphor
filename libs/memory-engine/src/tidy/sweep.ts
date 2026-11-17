import { fingerprintMemories } from './fingerprints'
import {
  emptyBrainTidyCoverage,
  type BrainTidyCoverage,
  type BrainTidySweep,
  type BrainTidyTouched,
} from '@phosphor/shared/brain-tidy'
import { all, one, run, transaction, type Context } from '../database'
import { bumpRevision } from '../prefs'
import { sweepEntity } from './sweep-entities'
import { memoryCandidateCache } from './memory-candidates'
import { sweepMemory } from './sweep-memories'

export const TIDY_CHUNK = 128
interface Cursor extends BrainTidyCoverage {
  entityMax: number
  memoryMax: number
}
export function coverage(ctx: Context): Cursor {
  const row = one<Cursor>(
    ctx,
    `SELECT phase,cursor,entities,memories,total_entities AS totalEntities,total_memories AS totalMemories,entity_max AS entityMax,memory_max AS memoryMax,capped_buckets AS cappedBuckets,started_at AS startedAt,finished_at AS finishedAt FROM tidy_sweep WHERE singleton=1`,
  )!
  return ['entities', 'memories', 'done'].includes(row.phase)
    ? row
    : { ...emptyBrainTidyCoverage(), entityMax: 0, memoryMax: 0 }
}
function start(ctx: Context): Cursor {
  const c = { ...emptyBrainTidyCoverage(), startedAt: ctx.now(), entityMax: 0, memoryMax: 0 }
  for (const table of ['entities', 'memories'] as const) {
    const row = one<{ total: number; max: number }>(
      ctx,
      `SELECT COUNT(*) AS total,COALESCE(MAX(n),0) AS max FROM ${table}`,
    )!
    if (table === 'entities') {
      c.totalEntities = row.total
      c.entityMax = row.max
    } else {
      c.totalMemories = row.total
      c.memoryMax = row.max
    }
  }
  return c
}
function save(ctx: Context, c: Cursor): void {
  run(
    ctx,
    'UPDATE tidy_sweep SET phase=?,cursor=?,entities=?,memories=?,total_entities=?,total_memories=?,entity_max=?,memory_max=?,capped_buckets=?,started_at=?,finished_at=? WHERE singleton=1',
    c.phase,
    c.cursor,
    c.entities,
    c.memories,
    c.totalEntities,
    c.totalMemories,
    c.entityMax,
    c.memoryMax,
    c.cappedBuckets,
    c.startedAt,
    c.finishedAt,
  )
}
export function sweep(
  ctx: Context,
  input: BrainTidyTouched | 'all',
  preferredEntityId?: string,
): BrainTidySweep {
  return transaction(ctx, () => {
    let c = coverage(ctx)
    const result: BrainTidySweep = { coverage: c, suggestions: 0, folded: 0, operationIds: [] }
    const entities = input === 'all' ? [] : [...new Set(input.entityIds)]
    const memories =
      input === 'all'
        ? []
        : all<{ n: number }>(
            ctx,
            'SELECT n FROM memories WHERE id IN (SELECT value FROM json_each(?))',
            JSON.stringify(input.memoryIds),
          ).map((m) => m.n)
    if (input === 'all') {
      if (c.startedAt === null || c.phase === 'done') c = start(ctx)
      const table = c.phase === 'entities' ? 'entities' : 'memories'
      const max = c.phase === 'entities' ? c.entityMax : c.memoryMax
      const rows = all<{ n: number; id: string }>(
        ctx,
        `SELECT n,id FROM ${table} WHERE n>? AND n<=? ORDER BY n LIMIT ?`,
        c.cursor,
        max,
        TIDY_CHUNK,
      )
      for (const row of rows) {
        if (table === 'entities') entities.push(row.id)
        else memories.push(row.n)
      }
      c.cursor = rows.at(-1)?.n ?? max
      c[table] += rows.length
      if (rows.length < TIDY_CHUNK || c.cursor >= max) {
        c.phase = table === 'entities' ? 'memories' : 'done'
        c.cursor = 0
        if (c.phase === 'done') c.finishedAt = ctx.now()
      }
    }
    for (const id of entities) {
      const found = sweepEntity(ctx, id, preferredEntityId)
      result.suggestions += found.suggestions
      c.cappedBuckets += found.capped
    }
    fingerprintMemories(ctx, memories)
    const cache = memoryCandidateCache()
    for (const n of memories) {
      const found = sweepMemory(ctx, n, cache)
      result.suggestions += found.suggestions
      c.cappedBuckets += found.capped
      result.operationIds.push(...found.operations)
    }
    result.folded = result.operationIds.length
    if (result.suggestions) bumpRevision(ctx)
    if (input === 'all') save(ctx, c)
    result.coverage = c
    return result
  })
}
